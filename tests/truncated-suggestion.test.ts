import { describe, it, expect } from 'vitest';
import { narrowTruncatedSuggestion } from '@/lib/truncated-suggestion';
import { parseAndLocate } from '@/agent/proofread';

// Реальные случаи из заказов #2 и #3: LLM вернула фразу целиком в original,
// а в suggested — только исправленный кусок. Экспорт молча терял остальные слова.
describe('обрезанная замена от LLM', () => {
  it('сужает до хвоста фразы (е→ё)', () => {
    const original = 'Ответы на эти вопросы пытливый читатель найдет';
    const r = narrowTruncatedSuggestion(original, 'найдёт');
    expect(r).not.toBeNull();
    expect(original.slice(r!.start, r!.end)).toBe('найдет');
  });

  it('сужает до начала фразы', () => {
    const original = 'а еще служил в нотариальной конторе';
    const r = narrowTruncatedSuggestion(original, 'а ещё служил');
    expect(original.slice(r!.start, r!.end)).toBe('а еще служил');
  });

  it('сужает до середины фразы', () => {
    const original = 'он более ста лет тому назад указывал па промышленное';
    const r = narrowTruncatedSuggestion(original, 'указывал на промышленное');
    expect(original.slice(r!.start, r!.end)).toBe('указывал па промышленное');
  });

  it('допускает две правленые буквы', () => {
    const original = 'Свое ученое объединение ярославцы';
    const r = narrowTruncatedSuggestion(original, 'Своё учёное объединение');
    expect(original.slice(r!.start, r!.end)).toBe('Свое ученое объединение');
  });

  it('не трогает честное удаление (suggested — подстрока original)', () => {
    expect(narrowTruncatedSuggestion('Именной указатель /создать новый/', 'Именной указатель')).toBeNull();
  });

  it('не трогает осмысленную переформулировку', () => {
    expect(
      narrowTruncatedSuggestion('в конце 1860-х годов века он впервые', 'в конце 1860-х годов он впервые'),
    ).toBeNull();
  });

  it('не трогает замену той же длины в словах', () => {
    expect(narrowTruncatedSuggestion('качественая печать', 'качественная печать')).toBeNull();
  });
});

describe('parseAndLocate: обрезанная замена не теряет текст', () => {
  it('сужает span до исправляемого слова', () => {
    const base = 'Вступление. Ответы на эти вопросы пытливый читатель найдет в книге.';
    const raw = JSON.stringify([
      {
        original: 'Ответы на эти вопросы пытливый читатель найдет',
        suggested: 'найдёт',
        context_before: 'Вступление. ',
        category: 'spelling',
        severity: 'normal',
        confidence: 0.9,
        reason: 'ё обязательна',
      },
    ]);
    const out = parseAndLocate(raw, base, 1);
    expect(out).toHaveLength(1);
    expect(out[0].original).toBe('найдет');
    expect(out[0].suggested).toBe('найдёт');
    expect(base.slice(out[0].spanStart, out[0].spanEnd)).toBe('найдет');
    expect(out[0].contextBefore.endsWith('читатель ')).toBe(true);
  });
});
