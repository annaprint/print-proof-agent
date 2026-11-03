import type { Edit } from './types';

// Правка «е → ё»: замена только букв е/Е на ё/Ё, больше ничего не меняется.
export function isYoEdit(original: string, suggested: string): boolean {
  if (original === suggested || original.length !== suggested.length) return false;
  for (let i = 0; i < original.length; i++) {
    const a = original[i];
    const b = suggested[i];
    if (a === b) continue;
    if (!((a === 'е' && b === 'ё') || (a === 'Е' && b === 'Ё'))) return false;
  }
  return true;
}

function yoToYe(word: string): string {
  return word.replace(/ё/g, 'е').replace(/Ё/g, 'Е');
}

// Предложение без добавленной ё: слова с ё, которых не было в исходнике, пишутся через е.
export function stripAddedYo(original: string, suggested: string): string {
  const WORD = /[А-Яа-яЁё]+/g;
  const known = new Set((original.match(WORD) ?? []).map((w) => w.toLowerCase()));
  return suggested.replace(WORD, (w) => (known.has(w.toLowerCase()) ? w : yoToYe(w)));
}

const YO_DEMAND = /ё\s+обязательн|обязательн\S*\s+ё|буква\s+ё/i;

// Пояснение без требования «ё обязательна»; остальные части остаются как есть.
export function stripYoReason(reason: string): string {
  if (!YO_DEMAND.test(reason)) return reason;
  const rest = reason
    .split(/(?<=[;.])\s+/)
    .filter((part) => !YO_DEMAND.test(part))
    .join(' ')
    .replace(/;\s*$/, '');
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

// Правки для выгрузок дизайнеру: чистые замены на ё убраны, в смешанных ё заменена на е.
// База не меняется: original и координаты сохраняются, меняется только то, что видит дизайнер.
export function withoutYo<T extends Edit>(edits: T[]): T[] {
  return edits.flatMap((e) => {
    const suggested = stripAddedYo(e.original, e.suggested);
    return suggested === e.original ? [] : [{ ...e, suggested, reason: stripYoReason(e.reason) }];
  });
}
