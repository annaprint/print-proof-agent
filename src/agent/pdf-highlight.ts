// PDF для дизайнера: исходная книга с подсветкой мест правок (аннотации Highlight)
// и комментарием «было → стало» в каждой. Места ищутся по текстовому слою страницы;
// что не нашлось (переносы, разрывы строк) — возвращается в unmatched и остаётся в CSV-списке.
import { PDFDocument, PDFHexString } from 'pdf-lib';
import type { Edit } from '@/lib/types';
import { buildPageLookup, CATEGORY_LABEL } from '@/lib/designer-edits';
import { findEditRects, charWidthsFor, type PageItem } from '@/lib/pdf-highlight';

const COLOR: Record<string, [number, number, number]> = {
  spelling: [1, 0.85, 0.1],
  punctuation: [0.4, 0.8, 1],
  style: [0.8, 0.6, 1],
  typography: [0.7, 0.7, 0.7],
};
const COLOR_IMPORTANT: [number, number, number] = [1, 0.35, 0.35];

// pdfjs OPS: showText = 44, showSpacedText = 45; аргумент — массив глифов и сдвигов
const OPS_SHOW_TEXT = [44, 45];

interface StreamGlyph {
  ch: string;
  w: number;
}

// все глифы страницы в порядке вывода (по одному символу, ширина в 1/1000 em)
function glyphStream(opList: any): StreamGlyph[] {
  const stream: StreamGlyph[] = [];
  opList.fnArray.forEach((fn: number, i: number) => {
    if (!OPS_SHOW_TEXT.includes(fn)) return;
    for (const g of opList.argsArray[i][0] ?? []) {
      if (typeof g !== 'object' || !g?.unicode) continue;
      const chars = [...String(g.unicode).normalize('NFKC')];
      chars.forEach((ch) => stream.push({ ch, w: (g.width ?? 0) / chars.length }));
    }
  });
  return stream;
}

// глифы, из которых pdfjs собрал str, начиная с позиции from; пробелы, которых нет в потоке, пропускаем
function takeGlyphs(stream: StreamGlyph[], from: number, str: string): { glyphs: StreamGlyph[]; next: number } | null {
  const glyphs: StreamGlyph[] = [];
  let q = from;
  for (const c of str) {
    const g = stream[q];
    if (g && (g.ch === c || (/\s/.test(g.ch) && /\s/.test(c)))) {
      glyphs.push(g);
      q++;
    } else if (!/\s/.test(c)) {
      return null;
    }
  }
  return { glyphs, next: q };
}

async function readPageItems(buffer: Buffer, pages: Set<number>): Promise<Map<number, PageItem[]>> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    await parser.getInfo(); // инициализирует parser.doc
    const doc = (parser as any).doc;
    const out = new Map<number, PageItem[]>();
    for (const n of pages) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      const stream = glyphStream(await page.getOperatorList());
      let pos = 0;
      const items: PageItem[] = [];
      for (const it of tc.items as any[]) {
        if (typeof it.str !== 'string') continue;
        const item: PageItem = {
          str: it.str,
          x: it.transform[4],
          y: it.transform[5],
          w: it.width,
          h: Math.abs(it.transform[3]) || it.height || 10,
          hasEOL: !!it.hasEOL,
        };
        if (it.str.trim()) {
          let taken = takeGlyphs(stream, pos, it.str);
          if (!taken) {
            // потеряли синхронизацию — ищем начало строки дальше по потоку
            const head = [...it.str.trimStart()].slice(0, 4);
            for (let from = pos; from < Math.min(stream.length, pos + 500) && !taken; from++) {
              if (head.every((c, k) => stream[from + k]?.ch === c)) taken = takeGlyphs(stream, from, it.str);
            }
          }
          if (taken) {
            pos = taken.next;
            item.cw = charWidthsFor(it.str, taken.glyphs, item.w, item.h) ?? undefined;
          }
        }
        items.push(item);
      }
      out.set(n, items);
    }
    return out;
  } finally {
    await parser.destroy();
  }
}

export async function highlightPdf(
  buffer: Buffer,
  edits: Edit[],
  baseText: string,
): Promise<{ pdf: Uint8Array; highlighted: number; unmatched: Edit[] }> {
  const pageOf = buildPageLookup(baseText);
  const active = edits.filter((e) => e.decision !== 'rejected');
  const byPage = new Map<number, Edit[]>();
  const unmatched: Edit[] = [];
  for (const e of active) {
    const p = pageOf(e.spanStart);
    if (p === null) unmatched.push(e);
    else byPage.set(p, [...(byPage.get(p) ?? []), e]);
  }

  const items = await readPageItems(buffer, new Set(byPage.keys()));
  const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const pdfPages = pdfDoc.getPages();
  let highlighted = 0;

  for (const [pageNo, pageEdits] of byPage) {
    const pdfPage = pdfPages[pageNo - 1];
    const pageItems = items.get(pageNo);
    if (!pdfPage || !pageItems) {
      unmatched.push(...pageEdits);
      continue;
    }
    for (const e of pageEdits) {
      const rects = findEditRects(pageItems, e);
      if (!rects) {
        unmatched.push(e);
        continue;
      }
      const quad = rects.flatMap((r) => [r.x, r.y + r.h, r.x + r.w, r.y + r.h, r.x, r.y, r.x + r.w, r.y]);
      const annot = pdfDoc.context.obj({
        Type: 'Annot',
        Subtype: 'Highlight',
        Rect: [
          Math.min(...rects.map((r) => r.x)),
          Math.min(...rects.map((r) => r.y)),
          Math.max(...rects.map((r) => r.x + r.w)),
          Math.max(...rects.map((r) => r.y + r.h)),
        ],
        QuadPoints: quad,
        C: e.severity === 'important' ? COLOR_IMPORTANT : (COLOR[e.category] ?? COLOR.style),
        F: 4,
        T: PDFHexString.fromText('PrintProof'),
        Contents: PDFHexString.fromText(
          `[${CATEGORY_LABEL[e.category] ?? e.category}] «${e.original}» → «${e.suggested}» — ${e.reason}`,
        ),
      });
      pdfPage.node.addAnnot(pdfDoc.context.register(annot));
      highlighted++;
    }
  }

  return { pdf: await pdfDoc.save(), highlighted, unmatched };
}
