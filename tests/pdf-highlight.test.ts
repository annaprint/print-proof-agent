import { describe, it, expect } from 'vitest';
import { findEditRects, charWidthsFor, type PageItem } from '@/lib/pdf-highlight';

// строка «Мы рады: качественая печать» одним элементом, 26 символов на 260 pt (10 pt на символ)
const LINE: PageItem = { str: 'Мы рады: качественая печать', x: 100, y: 700, w: 270, h: 10, hasEOL: true };
const NEXT: PageItem = { str: 'Снова качественая работа.', x: 100, y: 686, w: 250, h: 10, hasEOL: true };

describe('findEditRects: место правки в текстовом слое страницы', () => {
  it('находит слово и считает прямоугольник пропорционально позиции в элементе', () => {
    const rects = findEditRects([LINE], { original: 'качественая', contextBefore: 'рады: ', contextAfter: ' печать' });
    expect(rects).toHaveLength(1);
    const start = LINE.str.indexOf('качественая');
    expect(rects![0].x).toBeCloseTo(100 + (270 * start) / LINE.str.length, 5);
    expect(rects![0].w).toBeCloseTo((270 * 'качественая'.length) / LINE.str.length, 5);
    expect(rects![0].y).toBeLessThanOrEqual(700);
    expect(rects![0].y + rects![0].h).toBeGreaterThanOrEqual(710);
  });

  it('при повторах выбирает вхождение по контексту', () => {
    const rects = findEditRects([LINE, NEXT], { original: 'качественая', contextBefore: 'Снова ', contextAfter: ' работа.' });
    expect(rects).toHaveLength(1);
    expect(rects![0].y).toBeLessThan(700); // вторая строка
  });

  it('повторы без подходящего контекста — не угадываем', () => {
    const rects = findEditRects([LINE, NEXT], { original: 'качественая', contextBefore: 'XXXX ', contextAfter: ' YYYY' });
    expect(rects).toBeNull();
  });

  it('единственное вхождение берём даже при неточном контексте', () => {
    const rects = findEditRects([LINE], { original: 'печать', contextBefore: 'другое ', contextAfter: '' });
    expect(rects).toHaveLength(1);
  });

  it('фрагмент через перенос строки даёт по прямоугольнику на строку', () => {
    const rects = findEditRects([LINE, NEXT], { original: 'печать Снова', contextBefore: 'качественая ', contextAfter: ' качественая' });
    expect(rects).toHaveLength(2);
  });

  it('не нашли в странице — null', () => {
    expect(findEditRects([LINE], { original: 'отсутствует', contextBefore: '', contextAfter: '' })).toBeNull();
  });

  it('учитывает схлопывание пробелов и пробельные элементы', () => {
    const items: PageItem[] = [
      { str: 'Мы', x: 10, y: 50, w: 20, h: 10 },
      { str: ' ', x: 30, y: 50, w: 3, h: 10 },
      { str: 'рады', x: 33, y: 50, w: 40, h: 10, hasEOL: true },
    ];
    expect(findEditRects(items, { original: 'Мы рады', contextBefore: '', contextAfter: '' })).toHaveLength(1);
  });
});

describe('charWidthsFor: ширины символов элемента по глифам шрифта', () => {
  const g = (ch: string, w: number) => ({ ch, w });

  it('ширины глифов в единицах 1/1000 em, умноженные на кегль', () => {
    const cw = charWidthsFor('ab c', [g('a', 500), g('b', 500), g(' ', 250), g('c', 500)], 17.5, 10);
    expect(cw).toEqual([5, 5, 2.5, 5]);
  });

  it('добавочная ширина строки (выключка) достаётся пробелам', () => {
    const cw = charWidthsFor('ab c', [g('a', 500), g('b', 500), g(' ', 250), g('c', 500)], 20, 10);
    expect(cw).toEqual([5, 5, 5, 5]);
  });

  it('пробел, добавленный pdfjs между операторами, получает ширину по умолчанию', () => {
    const cw = charWidthsFor('ab c', [g('a', 500), g('b', 500), g('c', 500)], 17.5, 10);
    expect(cw).toHaveLength(4);
    expect(cw![2]).toBeCloseTo(2.5, 5);
  });

  it('текст элемента не совпал с глифами — null', () => {
    expect(charWidthsFor('abc', [g('a', 500), g('x', 500), g('c', 500)], 15, 10)).toBeNull();
  });
});

describe('findEditRects: пословные ширины', () => {
  it('использует cw вместо пропорционального деления', () => {
    const item: PageItem = { str: 'abcd', x: 0, y: 0, w: 60, h: 10, cw: [30, 10, 10, 10] };
    const rects = findEditRects([item], { original: 'cd', contextBefore: '', contextAfter: '' });
    expect(rects![0].x).toBeCloseTo(40, 5);
    expect(rects![0].w).toBeCloseTo(20, 5);
  });
});
