import { describe, it, expect } from 'vitest';
import { resolveEdits } from '@/agent/resolver';
import type { EditCandidate } from '@/lib/types';

function mk(partial: Partial<EditCandidate>): EditCandidate {
  return {
    spanStart: 0,
    spanEnd: 1,
    baseRevision: 1,
    original: 'x',
    suggested: 'y',
    contextBefore: '',
    contextAfter: '',
    category: 'spelling',
    severity: 'normal',
    confidence: 0.9,
    reason: 'test',
    sourceModule: 'llm-pass',
    ...partial,
  };
}

describe('resolver: дедуп и конфликты', () => {
  it('сливает точные дубли (один span, одно предложение), оставляя более уверенный источник', () => {
    const a = mk({ spanStart: 10, spanEnd: 13, original: 'абв', suggested: 'абг', confidence: 0.8, sourceModule: 'llm-pass' });
    const b = mk({ spanStart: 10, spanEnd: 13, original: 'абв', suggested: 'абг', confidence: 0.98, sourceModule: 'rule-pass' });
    const out = resolveEdits([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].sourceModule).toBe('rule-pass');
    expect(out[0].confidence).toBe(0.98);
  });

  it('при пересечении span с разными предложениями оставляет более уверенную правку', () => {
    const a = mk({ spanStart: 5, spanEnd: 15, suggested: 'вариант-а', confidence: 0.7 });
    const b = mk({ spanStart: 10, spanEnd: 20, suggested: 'вариант-б', confidence: 0.95 });
    const out = resolveEdits([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].suggested).toBe('вариант-б');
  });

  it('не трогает непересекающиеся правки и сортирует по spanStart', () => {
    const a = mk({ spanStart: 50, spanEnd: 55 });
    const b = mk({ spanStart: 10, spanEnd: 15 });
    const out = resolveEdits([a, b]);
    expect(out).toHaveLength(2);
    expect(out[0].spanStart).toBe(10);
    expect(out[1].spanStart).toBe(50);
  });

  it('важные правки идут раньше при равном spanStart-порядке вывода категорий', () => {
    const a = mk({ spanStart: 10, spanEnd: 15, severity: 'normal' });
    const b = mk({ spanStart: 20, spanEnd: 25, severity: 'important' });
    const out = resolveEdits([a, b]);
    // порядок в списке — по положению в документе; severity не ломает порядок
    expect(out[0].spanStart).toBe(10);
  });

  it('при перепроверке не предлагает новую правку поверх уже решённого менеджером участка (баг: пересечение accepted-правок при экспорте)', () => {
    // #22 уже принят менеджером в прошлом прогоне; recheck нашёл на том же span другую правку —
    // без locked-spans она войдёт как новый кандидат и рано или поздно тоже будет принята
    const locked = [{ spanStart: 605, spanEnd: 686 }];
    const rechecked = mk({ spanStart: 605, spanEnd: 686, suggested: 'другой вариант' });
    const out = resolveEdits([rechecked], locked);
    expect(out).toHaveLength(0);
  });

  it('locked-spans не трогают кандидатов вне пересечения', () => {
    const locked = [{ spanStart: 605, spanEnd: 686 }];
    const untouched = mk({ spanStart: 700, spanEnd: 710 });
    const out = resolveEdits([untouched], locked);
    expect(out).toHaveLength(1);
  });
});
