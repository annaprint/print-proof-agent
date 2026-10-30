// Поиск места правки в текстовом слое страницы PDF для подсветки.
// Это приближение: прямоугольник слова внутри текстового элемента считается пропорционально
// позиции символов, поэтому края могут отличаться от настоящих на доли символа.
export interface PageItem {
  str: string;
  x: number; // pdf-координаты, origin — левый нижний угол
  y: number; // базовая линия
  w: number;
  h: number;
  hasEOL?: boolean;
  cw?: number[]; // ширина каждого символа str в pt (сумма = w); без неё делим ширину поровну
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// доли ширины элемента, занятые символами [from, to)
function fractions(item: PageItem, from: number, to: number): [number, number] {
  const len = Math.max(1, item.str.length);
  if (!item.cw || item.cw.length !== item.str.length) return [from / len, to / len];
  const total = item.cw.reduce((a, b) => a + b, 0) || 1;
  let a = 0;
  for (let i = 0; i < from; i++) a += item.cw[i];
  let b = a;
  for (let i = from; i < to; i++) b += item.cw[i];
  return [a / total, b / total];
}

// Ширины символов строки по глифам шрифта (ширина глифа в 1/1000 em). Нужны потому, что
// pdfjs отдаёт строку целиком, а буквы в ней разной ширины. Остаток ширины строки
// (выключка, межбуквенный интервал) достаётся пробелам, либо растягивает все символы.
export function charWidthsFor(
  str: string,
  glyphs: { ch: string; w: number }[],
  itemWidth: number,
  fontSize: number,
): number[] | null {
  const widths: number[] = [];
  let gi = 0;
  for (const c of str) {
    const g = glyphs[gi];
    if (g && (g.ch === c || (/\s/.test(g.ch) && /\s/.test(c)))) {
      widths.push((g.w * fontSize) / 1000);
      gi++;
    } else if (/\s/.test(c)) {
      widths.push((250 * fontSize) / 1000); // пробел, который pdfjs добавил между операторами
    } else {
      return null;
    }
  }
  if (gi !== glyphs.length) return null;
  const sum = widths.reduce((a, b) => a + b, 0);
  if (sum <= 0 || itemWidth <= 0) return null;
  const residual = itemWidth - sum;
  if (Math.abs(residual) < 0.01 * itemWidth) return widths;
  const spaces = [...str].filter((c) => /\s/.test(c)).length;
  if (residual > 0 && spaces > 0) return widths.map((w, i) => (/\s/.test(str[i]) ? w + residual / spaces : w));
  return widths.map((w) => (w * itemWidth) / sum);
}

const collapse = (s: string) => s.replace(/\s+/g, ' ');

export function findEditRects(
  items: PageItem[],
  edit: { original: string; contextBefore: string; contextAfter: string },
): Rect[] | null {
  // склеиваем текст страницы, схлопывая пробелы; для каждого символа помним элемент и позицию в нём
  let joined = '';
  const charItem: number[] = [];
  const charPos: number[] = [];
  items.forEach((item, ii) => {
    for (let i = 0; i < item.str.length; i++) {
      const ch = item.str[i];
      if (/\s/.test(ch)) {
        if (joined.endsWith(' ')) continue;
        joined += ' ';
      } else {
        joined += ch;
      }
      charItem.push(ii);
      charPos.push(i);
    }
    if (item.hasEOL && !joined.endsWith(' ')) {
      joined += ' ';
      charItem.push(ii);
      charPos.push(item.str.length);
    }
  });

  const target = collapse(edit.original);
  if (!target.trim()) return null;
  const before = collapse(edit.contextBefore).trimEnd();
  const after = collapse(edit.contextAfter).trimStart();

  const starts: number[] = [];
  for (let from = joined.indexOf(target); from !== -1; from = joined.indexOf(target, from + 1)) starts.push(from);
  if (starts.length === 0) return null;

  const contextOk = (idx: number) => {
    const have = joined.slice(0, idx).trimEnd();
    const next = joined.slice(idx + target.length).trimStart();
    const beforeOk = before === '' || have.endsWith(before) || (have.length < before.length && before.endsWith(have));
    const afterOk = after === '' || next.startsWith(after) || (next.length < after.length && after.startsWith(next));
    return beforeOk && afterOk;
  };

  let chosen: number | undefined = starts.find(contextOk);
  if (chosen === undefined && starts.length === 1) chosen = starts[0];
  if (chosen === undefined) return null;

  // непрерывные отрезки символов внутри одного элемента → по прямоугольнику
  const rects: Rect[] = [];
  let k = chosen;
  const end = chosen + target.length;
  while (k < end) {
    const ii = charItem[k];
    const first = charPos[k];
    let last = first;
    while (k + 1 < end && charItem[k + 1] === ii) {
      k++;
      last = charPos[k];
    }
    k++;
    const item = items[ii];
    const len = Math.max(1, item.str.length);
    const [f0, f1] = fractions(item, first, Math.min(last + 1, len));
    const x0 = item.x + item.w * f0;
    const x1 = item.x + item.w * f1;
    if (x1 - x0 <= 0) continue;
    const rect = { x: x0, y: item.y - 0.2 * item.h, w: x1 - x0, h: 1.2 * item.h };
    // соседние элементы одной строки сливаем в один прямоугольник
    const prev = rects[rects.length - 1];
    if (prev && Math.abs(prev.y - rect.y) < 0.5 * rect.h) {
      const right = Math.max(prev.x + prev.w, rect.x + rect.w);
      prev.x = Math.min(prev.x, rect.x);
      prev.w = right - prev.x;
    } else {
      rects.push(rect);
    }
  }
  return rects.length > 0 ? rects : null;
}
