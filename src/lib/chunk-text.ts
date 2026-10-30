// Деление большого текста на части для llm-pass: один вызов модели на всю книгу
// не укладывается в лимит выхода и идёт часами. Части покрывают текст без пропусков,
// start — смещение части в базовой ревизии (span-координаты остаются в одной ревизии).
import type { EditCandidate } from './types';

export interface TextChunk {
  start: number;
  text: string;
}

export const LLM_CHUNK_CHARS = 15000;

// последняя граница внутри окна, не ближе половины окна (чтобы не плодить мелкие части)
function findCut(window: string): number {
  const min = Math.floor(window.length / 2);
  const para = window.lastIndexOf('\n\n');
  if (para >= min) return para + 2;
  const line = window.lastIndexOf('\n');
  if (line >= min) return line + 1;
  let sentence = -1;
  for (const m of window.matchAll(/[.!?…]["»)]?\s+/g)) sentence = m.index! + m[0].length;
  if (sentence >= min) return sentence;
  const space = window.lastIndexOf(' ');
  if (space >= min) return space + 1;
  return window.length;
}

export function chunkText(text: string, maxChars: number = LLM_CHUNK_CHARS): TextChunk[] {
  const chunks: TextChunk[] = [];
  let pos = 0;
  while (pos < text.length) {
    if (text.length - pos <= maxChars) {
      chunks.push({ start: pos, text: text.slice(pos) });
      break;
    }
    const cut = findCut(text.slice(pos, pos + maxChars));
    chunks.push({ start: pos, text: text.slice(pos, pos + cut) });
    pos += cut;
  }
  return chunks;
}

export function shiftToBase(edits: EditCandidate[], offset: number, baseText: string): EditCandidate[] {
  return edits.map((e) => {
    const spanStart = e.spanStart + offset;
    const spanEnd = e.spanEnd + offset;
    return {
      ...e,
      spanStart,
      spanEnd,
      original: baseText.slice(spanStart, spanEnd),
      contextBefore: baseText.slice(Math.max(0, spanStart - 30), spanStart),
      contextAfter: baseText.slice(spanEnd, spanEnd + 30),
    };
  });
}
