import { describe, it, expect } from 'vitest';
import { buildPageLookup, designerEditsCsv } from '@/lib/designer-edits';
import type { Edit } from '@/lib/types';

const TEXT =
  'Первая страница текст.\n\n-- 1 of 3 --\n\nВторая страница текст.\n\n-- 2 of 3 --\n\nТретья страница текст.\n\n-- 3 of 3 --\n\n';

function mk(p: Partial<Edit>): Edit {
  return {
    orderId: 1, spanStart: 0, spanEnd: 1, baseRevision: 1, original: 'x', suggested: 'y',
    contextBefore: '', contextAfter: '', category: 'spelling', severity: 'normal',
    confidence: 0.98, reason: 'причина', sourceModule: 'llm-pass', decision: 'pending', ...p,
  };
}

describe('buildPageLookup: номер страницы по смещению в тексте PDF', () => {
  it('текст перед маркером «-- N of M --» относится к странице N', () => {
    const page = buildPageLookup(TEXT);
    expect(page(TEXT.indexOf('Первая'))).toBe(1);
    expect(page(TEXT.indexOf('Вторая'))).toBe(2);
    expect(page(TEXT.indexOf('Третья'))).toBe(3);
  });

  it('текст без маркеров страниц — страница неизвестна', () => {
    expect(buildPageLookup('Обычный текст без страниц.')(5)).toBeNull();
  });

  it('хвост после последнего маркера — страница неизвестна', () => {
    const page = buildPageLookup(TEXT + 'хвост');
    expect(page(TEXT.length + 1)).toBeNull();
  });
});

describe('designerEditsCsv: без замен на ё', () => {
  it('нет ё в колонке «Стало» и нет чистых замен е→ё', () => {
    const csv = designerEditsCsv(
      [
        { spanStart: 0, spanEnd: 4, original: 'ушел', suggested: 'ушёл', reason: 'Профиль клиента: буква ё обязательна', category: 'spelling', severity: 'normal', decision: 'pending', contextBefore: '', contextAfter: '' } as any,
        { spanStart: 5, spanEnd: 20, original: 'Разведчик сапер', suggested: 'Разведчик-сапёр', reason: 'Нужен дефис', category: 'spelling', severity: 'normal', decision: 'pending', contextBefore: '', contextAfter: '' } as any,
      ],
      'ушел Разведчик сапер',
    );
    expect(csv).not.toContain('ушёл');
    expect(csv).toContain('Разведчик-сапер');
    expect(csv).not.toContain('Разведчик-сапёр');
  });
});

describe('designerEditsCsv: список правок для ручного внесения', () => {
  const second = TEXT.indexOf('страница', TEXT.indexOf('Вторая'));
  const first = TEXT.indexOf('страница');

  it('сортирует по странице и позиции, отклонённые не включает', () => {
    const csv = designerEditsCsv(
      [
        mk({ spanStart: second, spanEnd: second + 8, original: 'страница', suggested: 'страница!' }),
        mk({ spanStart: first, spanEnd: first + 8, original: 'страница', suggested: 'страницы' }),
        mk({ spanStart: first, spanEnd: first + 8, original: 'страница', suggested: 'нет', decision: 'rejected' }),
      ],
      TEXT,
    );
    const lines = csv.replace('﻿', '').trim().split('\n');
    expect(lines[0]).toBe('Стр.;Было;Стало;Контекст;Тип;Важность;Статус;Пояснение');
    expect(lines).toHaveLength(3);
    expect(lines[1].startsWith('1;страница;страницы;')).toBe(true);
    expect(lines[2].startsWith('2;страница;страница!;')).toBe(true);
  });

  it('контекст показывает правку в окружении, русские подписи, BOM для Excel', () => {
    const csv = designerEditsCsv(
      [mk({ spanStart: first, spanEnd: first + 8, original: 'страница', suggested: 'страницы', contextBefore: 'Первая ', contextAfter: ' текст.', severity: 'important', decision: 'accepted', category: 'punctuation' })],
      TEXT,
    );
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('Первая [страница] текст.');
    expect(csv).toContain(';пунктуация;важно;принято;');
  });

  it('без номеров страниц (не PDF) колонка «Стр.» пустая', () => {
    const csv = designerEditsCsv([mk({ spanStart: 0, spanEnd: 3, original: 'Обы', suggested: 'Оби' })], 'Обычный текст.');
    const row = csv.replace('﻿', '').trim().split('\n')[1];
    expect(row.startsWith(';Обы;Оби;')).toBe(true);
  });

  it('статус «ждёт решения» для нерешённых', () => {
    const csv = designerEditsCsv([mk({ spanStart: first, spanEnd: first + 8, original: 'страница', suggested: 'страницы' })], TEXT);
    expect(csv).toContain(';ждёт решения;');
  });
});
