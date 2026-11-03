// Список правок для ручного внесения дизайнером: страница, было, стало, контекст.
// Номер страницы вычисляется кодом по маркерам «-- N of M --», которые pdf-parse
// ставит после текста каждой страницы; для текста без маркеров страница пустая.
import type { Edit } from './types';
import { cell } from './csv-export';
import { withoutYo } from './yo-edit';

const SEP = ';';
const HEADER = ['Стр.', 'Было', 'Стало', 'Контекст', 'Тип', 'Важность', 'Статус', 'Пояснение'];

export const CATEGORY_LABEL: Record<string, string> = {
  spelling: 'орфография',
  punctuation: 'пунктуация',
  style: 'стилистика',
  typography: 'типографика',
};

export function buildPageLookup(text: string): (offset: number) => number | null {
  const markers = [...text.matchAll(/-- (\d+) of \d+ --/g)].map((m) => ({ end: m.index!, page: Number(m[1]) }));
  return (offset) => {
    // первая страница, чей маркер стоит после смещения
    let lo = 0;
    let hi = markers.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (markers[mid].end >= offset) hi = mid;
      else lo = mid + 1;
    }
    return lo < markers.length ? markers[lo].page : null;
  };
}

export function designerEditsCsv(edits: Edit[], baseText: string): string {
  const pageOf = buildPageLookup(baseText);
  const rows = withoutYo(edits.filter((e) => e.decision !== 'rejected'))
    .map((e) => ({ e, page: pageOf(e.spanStart) }))
    .sort((a, b) => (a.page ?? Infinity) - (b.page ?? Infinity) || a.e.spanStart - b.e.spanStart)
    .map(({ e, page }) =>
      [
        page ?? '',
        e.original,
        e.suggested,
        `${e.contextBefore}[${e.original}]${e.contextAfter}`.replace(/\s+/g, ' '),
        CATEGORY_LABEL[e.category] ?? e.category,
        e.severity === 'important' ? 'важно' : '',
        e.decision === 'accepted' ? 'принято' : 'ждёт решения',
        e.reason,
      ]
        .map(cell)
        .join(SEP),
    );
  return '﻿' + [HEADER.join(SEP), ...rows].join('\n') + '\n';
}
