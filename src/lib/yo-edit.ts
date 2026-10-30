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
