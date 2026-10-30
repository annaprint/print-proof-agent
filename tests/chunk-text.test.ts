import { describe, it, expect } from 'vitest';
import { chunkText, shiftToBase } from '@/lib/chunk-text';
import type { EditCandidate } from '@/lib/types';

describe('chunkText: деление большого текста на части для llm-pass', () => {
  it('короткий текст — одна часть со start=0', () => {
    expect(chunkText('Короткий текст.', 100)).toEqual([{ start: 0, text: 'Короткий текст.' }]);
  });

  it('части без пропусков и наложений покрывают весь текст', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Абзац номер ${i}. Ещё одно предложение.`).join('\n\n');
    const chunks = chunkText(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.text).join('')).toBe(text);
    for (const c of chunks) {
      expect(text.slice(c.start, c.start + c.text.length)).toBe(c.text);
      expect(c.text.length).toBeLessThanOrEqual(200);
    }
  });

  it('режет по границе абзаца, а не посреди слова', () => {
    const text = 'а'.repeat(80) + '\n\n' + 'б'.repeat(80) + '\n\n' + 'в'.repeat(80);
    const chunks = chunkText(text, 120);
    expect(chunks[0].text).toBe('а'.repeat(80) + '\n\n');
    expect(chunks[1].text).toBe('б'.repeat(80) + '\n\n');
  });

  it('без абзацев режет по концу предложения', () => {
    const text = 'Первое предложение тут. Второе предложение тут. Третье предложение тут.';
    const chunks = chunkText(text, 50);
    expect(chunks[0].text).toBe('Первое предложение тут. Второе предложение тут. ');
    expect(chunks.map((c) => c.text).join('')).toBe(text);
  });

  it('сплошной текст без границ режется жёстко, но без потерь', () => {
    const text = 'x'.repeat(250);
    const chunks = chunkText(text, 100);
    expect(chunks.map((c) => c.text.length)).toEqual([100, 100, 50]);
  });
});

describe('shiftToBase: координаты правки из части → координаты всей базовой ревизии', () => {
  const base = 'Начало книги. Вторая часть: качественая печать и ещё текст после.';
  const start = base.indexOf('Вторая');
  const part = base.slice(start);

  it('сдвигает span и пересчитывает контекст по полному тексту', () => {
    const local: EditCandidate = {
      spanStart: part.indexOf('качественая'),
      spanEnd: part.indexOf('качественая') + 'качественая'.length,
      baseRevision: 1,
      original: 'качественая',
      suggested: 'качественная',
      contextBefore: '',
      contextAfter: '',
      category: 'spelling',
      severity: 'normal',
      confidence: 0.9,
      reason: 'НН',
      sourceModule: 'llm-pass',
    };
    const [e] = shiftToBase([local], start, base);
    expect(base.slice(e.spanStart, e.spanEnd)).toBe('качественая');
    expect(e.contextBefore).toBe(base.slice(Math.max(0, e.spanStart - 30), e.spanStart));
    expect(e.contextAfter).toBe(base.slice(e.spanEnd, e.spanEnd + 30));
  });
});
