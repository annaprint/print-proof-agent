// Vision-pass: проверка макета (PNG/JPEG/PDF-рендер) → замечания для дизайнера.
// Координаты vision ненадёжны (аудит Codex) → выдаём block_hint, не автоправки.
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { LayoutIssue } from '@/lib/types';

const SYSTEM = `Ты — выпускающий инспектор типографии. Тебе дают путь к изображению макета (листовка/буклет). Прочитай файл инструментом Read и проверь:
1. Налезающие друг на друга блоки текста/графики
2. Обрезанные или нечитаемые элементы (мелкий кегль, низкий контраст)
3. Опечатки и ошибки в видимом тексте
4. Типографика: дефисы вместо тире, прямые кавычки
Ответь ТОЛЬКО валидным JSON-массивом:
[{"page": 1, "block_hint": "где на странице (напр. 'правый нижний угол, блок с ценами')", "description": "что не так и как исправить", "category": "overlap|readability|text|typography", "severity": "normal|important", "confidence": 0.0-1.0, "bbox": {"x": 0, "y": 0, "w": 0, "h": 0}, "anchor_text": "точный фрагмент текста, к которому относится замечание, или null"}]
bbox — прямоугольник проблемной области в нормализованных координатах 0–1000 (x,y — левый верхний угол; вся ширина изображения = 1000, вся высота = 1000). Указывай bbox максимально точно; если не можешь локализовать область — "bbox": null.
anchor_text — если замечание про конкретный текст, скопируй этот фрагмент ТОЧНО как он напечатан (5-40 символов); для чисто визуальных проблем — null.
Если проблем нет — []. Никакого текста вне JSON.`;

function cleanEnv() {
  const env = { ...process.env } as Record<string, string | undefined>;
  delete env.ANTHROPIC_API_KEY;
  return env;
}

export async function runVisionPass(
  imagePath: string,
  onResult?: (resultMessage: unknown) => void,
): Promise<Omit<LayoutIssue, 'orderId' | 'id' | 'decision'>[]> {
  let raw = '';
  for await (const message of query({
    prompt: `Проверь макет: ${imagePath}`,
    options: {
      systemPrompt: SYSTEM,
      model: 'claude-opus-5-5',
      effort: 'max', // максимальная глубина вычитки
      tools: ['Read'],
      allowedTools: ['Read'],
      maxTurns: 3,
      env: cleanEnv(),
    } as any,
  })) {
    const m = message as any;
    if (m.type === 'result') {
      if (m.subtype === 'success') raw = m.result ?? '';
      onResult?.(m);
    }
  }

  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  try {
    const items = JSON.parse(jsonMatch[0]) as any[];
    return items.map((it) => {
      // валидация bbox: четыре числа в диапазоне 0–1000, иначе null
      let bbox: { x: number; y: number; w: number; h: number } | null = null;
      const b = it.bbox;
      if (b && [b.x, b.y, b.w, b.h].every((v: any) => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1000) && Number(b.w) > 0 && Number(b.h) > 0) {
        bbox = { x: Number(b.x), y: Number(b.y), w: Math.min(Number(b.w), 1000 - Number(b.x)), h: Math.min(Number(b.h), 1000 - Number(b.y)) };
      }
      return {
        page: Number(it.page) || 1,
        blockHint: String(it.block_hint ?? ''),
        description: String(it.description ?? ''),
        category: String(it.category ?? 'layout'),
        severity: it.severity === 'important' ? 'important' as const : 'normal' as const,
        confidence: Math.min(1, Math.max(0, Number(it.confidence) || 0.7)),
        bbox,
        anchorText: it.anchor_text ? String(it.anchor_text) : null,
      };
    });
  } catch {
    return [];
  }
}
