// Чат-агент раздела «Профили»: создание и редактирование профилей клиентов разговором.
// Custom tools работают in-process (createSdkMcpServer) и напрямую пишут в SQLite.
// Каждое изменение профиля сообщается наружу через onProfileChange — UI рисует виджет.
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { q } from '@/lib/db';
import type { ProfileRules, StyleExample } from '@/lib/types';

const SYSTEM = `Ты — ассистент настройки профилей клиентов в PrintProof (агент-корректор типографии).

Возможности инструмента, о которых ты знаешь и рассказываешь пользователю:
- Профиль клиента = детерминированные правила + стилевые указания + примеры правок.
- Детерминированные правила (исполняет rule-pass, без LLM, 100% повторяемо): ё обязательна/нет, кавычки «ёлочки»/прямые, бренд-словарь (неверное → верное написание терминов и названий).
- Стилевые указания (stylePrompt, исполняет llm-pass): тон, лексика, что считать ошибкой стиля.
- Примеры правок (examples, few-shot для llm-pass): пары «было → как нравится клиенту». Если пользователь бросает референс или описание стиля — дистиллируй в stylePrompt и/или примеры.
- Профиль подключается к каждому заказу клиента; правки получают provenance «профиль клиента».

Правила работы:
- Всегда используй инструменты для чтения/изменения профилей — не выдумывай содержимое.
- После изменения коротко подтверди, что поменялось. Не пересказывай весь профиль — виджет покажет.
- Если пользователь даёт текст-референс, предложи, что извлечь: детерминированные замены → бренд-словарь, стилевые наблюдения → stylePrompt, конкретные пары правок → examples.
- Отвечай по-русски, кратко.`;

export interface ProfileChatEvents {
  onText: (text: string) => void;
  onProfileChange: (profile: { id: number; name: string; rules: ProfileRules; notes?: string }) => void;
  onToolUse: (name: string) => void;
}

const rulesShape = {
  enforceYo: z.boolean().optional().describe('буква ё обязательна'),
  quotes: z.enum(['guillemets', 'straight']).optional().describe('тип кавычек'),
  brandDictionary: z.record(z.string(), z.string()).optional().describe('словарь замен: неверное → верное'),
  stylePrompt: z.string().optional().describe('стилевые указания для llm-pass'),
};

function buildServer(events: ProfileChatEvents) {
  const emit = (id: number) => {
    const p = q.listProfiles().find((p) => p.id === id);
    if (p) events.onProfileChange(p);
  };

  return createSdkMcpServer({
    name: 'profiles',
    version: '1.0.0',
    tools: [
      tool('list_profiles', 'Список всех профилей клиентов с правилами', {}, async () => ({
        content: [{ type: 'text', text: JSON.stringify(q.listProfiles()) }],
      })),
      tool(
        'create_profile',
        'Создать профиль клиента',
        { name: z.string().describe('название, обычно имя клиента'), notes: z.string().optional(), ...rulesShape },
        async (a: any) => {
          const rules: ProfileRules = {
            enforceYo: a.enforceYo, quotes: a.quotes,
            brandDictionary: a.brandDictionary ?? {}, stylePrompt: a.stylePrompt, examples: [],
          };
          const id = q.createProfile(a.name, rules, a.notes);
          emit(id);
          return { content: [{ type: 'text', text: `создан профиль #${id}` }] };
        },
      ),
      tool(
        'update_profile',
        'Изменить правила/название профиля. Передавай только изменяемые поля; brandDictionary сливается с существующим.',
        { id: z.number(), name: z.string().optional(), notes: z.string().optional(), ...rulesShape },
        async (a: any) => {
          const cur = q.getProfile(a.id);
          if (!cur) return { content: [{ type: 'text', text: `профиль #${a.id} не найден` }], isError: true };
          const rules: ProfileRules = {
            ...cur.rules,
            ...(a.enforceYo !== undefined ? { enforceYo: a.enforceYo } : {}),
            ...(a.quotes ? { quotes: a.quotes } : {}),
            ...(a.stylePrompt !== undefined ? { stylePrompt: a.stylePrompt } : {}),
            ...(a.brandDictionary ? { brandDictionary: { ...cur.rules.brandDictionary, ...a.brandDictionary } } : {}),
          };
          q.updateProfile(a.id, { name: a.name, rules, notes: a.notes });
          emit(a.id);
          return { content: [{ type: 'text', text: `профиль #${a.id} обновлён` }] };
        },
      ),
      tool(
        'add_style_example',
        'Добавить пример правки «было → как нравится клиенту» (few-shot для корректора)',
        { id: z.number(), before: z.string(), after: z.string(), note: z.string().optional() },
        async (a: any) => {
          const cur = q.getProfile(a.id);
          if (!cur) return { content: [{ type: 'text', text: `профиль #${a.id} не найден` }], isError: true };
          const examples: StyleExample[] = [...(cur.rules.examples ?? []), { before: a.before, after: a.after, note: a.note }];
          q.updateProfile(a.id, { rules: { ...cur.rules, examples } });
          emit(a.id);
          return { content: [{ type: 'text', text: `пример добавлен, всего ${examples.length}` }] };
        },
      ),
      tool(
        'remove_style_example',
        'Удалить пример правки по индексу (0-based)',
        { id: z.number(), index: z.number() },
        async (a: any) => {
          const cur = q.getProfile(a.id);
          if (!cur) return { content: [{ type: 'text', text: `профиль #${a.id} не найден` }], isError: true };
          const examples = [...(cur.rules.examples ?? [])];
          examples.splice(a.index, 1);
          q.updateProfile(a.id, { rules: { ...cur.rules, examples } });
          emit(a.id);
          return { content: [{ type: 'text', text: `пример удалён, осталось ${examples.length}` }] };
        },
      ),
    ],
  });
}

function cleanEnv() {
  const env = { ...process.env } as Record<string, string | undefined>;
  delete env.ANTHROPIC_API_KEY; // подписка Claude Code, не API-ключ
  return env;
}

export async function runProfileChat(transcript: string, events: ProfileChatEvents): Promise<void> {
  const server = buildServer(events);

  for await (const message of query({
    prompt: transcript,
    options: {
      systemPrompt: SYSTEM,
      model: 'claude-opus-5-5',
      mcpServers: { profiles: server },
      allowedTools: [
        'mcp__profiles__list_profiles',
        'mcp__profiles__create_profile',
        'mcp__profiles__update_profile',
        'mcp__profiles__add_style_example',
        'mcp__profiles__remove_style_example',
      ],
      tools: [],
      maxTurns: 12,
      env: cleanEnv(),
    } as any,
  })) {
    const m = message as any;
    if (m.type === 'assistant') {
      for (const block of m.message?.content ?? []) {
        if (block.type === 'text' && block.text) events.onText(block.text);
        if (block.type === 'tool_use') events.onToolUse(String(block.name ?? ''));
      }
    }
  }
}
