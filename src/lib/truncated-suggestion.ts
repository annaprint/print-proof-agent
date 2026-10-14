// Защита от обрезанной замены: LLM кладёт в original фразу целиком, а в suggested —
// только исправленный кусок («...читатель найдет» → «найдёт»). Применённая как есть,
// такая правка стирает остальные слова фразы.
// Если suggested короче по словам и почти совпадает (до 2 правок) с непрерывным окном
// слов original — возвращаем границы этого окна, правку надо сузить до него.
// Худший случай ложного срабатывания — правка применится не полностью; текст не теряется.

const MAX_DISTANCE = 2;

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    prev = cur;
  }
  return prev[b.length];
}

export function narrowTruncatedSuggestion(
  original: string,
  suggested: string,
): { start: number; end: number } | null {
  if (original.includes(suggested)) return null; // честное удаление слов

  const words = [...original.matchAll(/\S+/g)];
  const k = suggested.split(/\s+/).filter(Boolean).length;
  if (k === 0 || k >= words.length) return null;

  let best: { start: number; end: number; dist: number } | null = null;
  for (let i = 0; i + k <= words.length; i++) {
    const start = words[i].index!;
    const end = words[i + k - 1].index! + words[i + k - 1][0].length;
    const dist = levenshtein(original.slice(start, end), suggested);
    if (!best || dist < best.dist) best = { start, end, dist };
  }
  return best && best.dist <= MAX_DISTANCE ? { start: best.start, end: best.end } : null;
}
