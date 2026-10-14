// LLM-pass: один вызов Agent SDK → структурированный список правок.
// LLM возвращает фрагменты + контекст, span-координаты вычисляет код (LLM ненадёжна в арифметике offsets).
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { EditCandidate, ProfileRules } from '@/lib/types';
import { narrowTruncatedSuggestion } from '@/lib/truncated-suggestion';

interface LlmEdit {
  original: string;
  suggested: string;
  context_before: string; // 10-20 символов прямо перед original — для поиска позиции
  category: 'spelling' | 'punctuation' | 'style';
  severity: 'normal' | 'important';
  confidence: number;
  reason: string;
}

const SYSTEM = `Ты — корректор русского языка в типографии. Найди ошибки в тексте: орфография (category=spelling), пунктуация (category=punctuation), стилистика (category=style).
НЕ трогай типографику (кавычки, тире, пробелы) — её правит отдельный модуль.
НЕ меняй смысл текста. severity=important — только если ошибка недопустима в печати (наращения числительных, грубые ошибки в заголовках).
original — минимальный фрагмент с ошибкой (слово или несколько слов), suggested — ПОЛНАЯ замена всего original: всё, что есть в original и не исправляется, повтори в suggested без изменений.
Ответь ТОЛЬКО валидным JSON-массивом объектов:
[{"original": "точный фрагмент с ошибкой", "suggested": "исправление", "context_before": "10-20 символов текста прямо перед фрагментом", "category": "spelling|punctuation|style", "severity": "normal|important", "confidence": 0.0-1.0, "reason": "краткое обоснование по-русски"}]
Если ошибок нет — верни []. Никакого текста вне JSON.`;

function cleanEnv() {
  // Используем подписку Claude Code, не API-ключ
  const env = { ...process.env } as Record<string, string | undefined>;
  delete env.ANTHROPIC_API_KEY;
  return env;
}

export async function runLlmPass(
  text: string,
  baseRevision: number,
  profile?: { name: string; rules: ProfileRules },
  onResult?: (resultMessage: unknown) => void, // фактический расход — наружу для протокола
): Promise<EditCandidate[]> {
  const style = profile?.rules.stylePrompt ? `\nСтилевые указания клиента: ${profile.rules.stylePrompt}` : '';
  const examples = profile?.rules.examples?.length
    ? `\nПримеры правок, как нравится клиенту (следуй этому вкусу):\n${profile.rules.examples
        .slice(0, 8)
        .map((ex) => `- «${ex.before}» → «${ex.after}»${ex.note ? ` (${ex.note})` : ''}`)
        .join('\n')}`
    : '';
  const profileNote = profile
    ? `\nПрофиль клиента «${profile.name}»: ${profile.rules.enforceYo ? 'буква ё обязательна (е→ё где нужно — category=spelling); ' : ''}${profile.rules.brandDictionary && Object.keys(profile.rules.brandDictionary).length ? 'словарь брендов учитывает отдельный модуль.' : ''}${style}${examples}`
    : '';

  const prompt = `${profileNote}\nТекст для корректуры (между маркерами):\n<<<НАЧАЛО>>>\n${text}\n<<<КОНЕЦ>>>`;

  let raw = '';
  let resultMeta = '';
  for await (const message of query({
    prompt,
    options: {
      systemPrompt: SYSTEM,
      model: 'claude-opus-4-8',
      tools: [], // чистая текстовая задача — инструменты не нужны
      maxTurns: 1,
      env: cleanEnv(),
    } as any,
  })) {
    const m = message as any;
    if (m.type === 'result') {
      resultMeta = `subtype=${m.subtype}`;
      if (m.subtype === 'success') raw = m.result ?? '';
      else raw = '';
      onResult?.(m);
    }
  }

  // fail-closed: ошибка SDK (не success) — это НЕ «ошибок в тексте нет».
  // Бросаем, чтобы каскад пометил заказ agent_error, а не отправил в review с пустым списком.
  if (!resultMeta.includes('success')) {
    throw new Error(`llm-pass: Agent SDK вернул ${resultMeta || 'без result'} — проверка не выполнена`);
  }

  const located = parseAndLocate(raw, text, baseRevision);
  if (process.env.PRINTPROOF_DEBUG || located.length === 0) {
    console.error(`[llm-pass] ${resultMeta}, raw ${raw.length} chars, located ${located.length}:`, raw.slice(0, 500));
  }
  return located;
}

// exported отдельно — тестируется без LLM
export function parseAndLocate(raw: string, baseText: string, baseRevision: number): EditCandidate[] {
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  let items: LlmEdit[];
  try {
    items = JSON.parse(jsonMatch[0]);
  } catch {
    return [];
  }

  const out: EditCandidate[] = [];
  for (const it of items) {
    if (!it.original || !it.suggested || it.original === it.suggested) continue;
    // ищем точную позицию: сперва по context_before + original, затем по original
    let start = -1;
    if (it.context_before) {
      const anchor = baseText.indexOf(it.context_before + it.original);
      if (anchor !== -1) start = anchor + it.context_before.length;
    }
    if (start === -1) start = baseText.indexOf(it.original);
    if (start === -1) continue; // LLM сослалась на несуществующий фрагмент — отбрасываем

    let end = start + it.original.length;
    // обрезанная замена («фраза» → «слово») стёрла бы часть текста — сужаем span
    const narrowed = narrowTruncatedSuggestion(it.original, it.suggested);
    if (narrowed) {
      end = start + narrowed.end;
      start += narrowed.start;
    }
    out.push({
      spanStart: start,
      spanEnd: end,
      baseRevision,
      original: baseText.slice(start, end),
      suggested: it.suggested,
      contextBefore: baseText.slice(Math.max(0, start - 30), start),
      contextAfter: baseText.slice(end, end + 30),
      category: (['spelling', 'punctuation', 'style'] as const).includes(it.category as any) ? it.category : 'style',
      severity: it.severity === 'important' ? 'important' : 'normal',
      confidence: Math.min(1, Math.max(0, Number(it.confidence) || 0.8)),
      reason: it.reason || 'правка корректора',
      sourceModule: 'llm-pass',
    });
  }
  return out;
}
