// Оценка заказа: объём / время / цена — с прозрачной разбивкой.
// Цена клиенту — детерминированный тариф (предсказуемость = ключевая ценность),
// но в breakdown показываем и себестоимость токенов: модель, вход/выход, курс.
import type { Estimate, OrderType } from '@/lib/types';

const EUR_PER_1000_CHARS = 0.5; // тариф пилота
const MIN_TEXT_EUR = 0.6;
const LAYOUT_BASE_EUR = 0.8; // vision-проверка одной страницы
const SECONDS_PER_1000_CHARS = 90;
const LAYOUT_SECONDS = 120;

// Модель и цены (claude-opus-5-5, USD за миллион токенов; источник: справочник Claude API)
const MODEL = 'claude-opus-5-5';
const USD_PER_MTOK_IN = 4;
const USD_PER_MTOK_OUT = 20;
const USD_TO_EUR = 0.92;

// Эмпирика токенов: русский текст ≈ 1 токен на ~3 символа; системный промпт корректора ≈ 800;
// JSON правок на выходе ≈ объём/6 + 200; изображение страницы ≈ 1600 токенов входа + 600 выхода.
const SYSTEM_OVERHEAD_TOKENS = 800;
const IMAGE_TOKENS_IN = 1600;
const IMAGE_TOKENS_OUT = 600;

export function estimateOrder(type: OrderType, chars: number, pages = 1): Estimate {
  let etaSeconds = 30; // нормализация + resolver
  let tariffEur = 0;
  const formulaParts: string[] = [];

  let inputTokens = 0;
  let outputTokens = 0;

  if (chars > 0) {
    etaSeconds += (chars / 1000) * SECONDS_PER_1000_CHARS;
    const textTariff = Math.max(MIN_TEXT_EUR, (chars / 1000) * EUR_PER_1000_CHARS);
    tariffEur += textTariff;
    formulaParts.push(`текст: ${chars.toLocaleString('ru')} зн × 0,50 €/1000 (мин. 0,60) = ${textTariff.toFixed(2)} €`);
    inputTokens += Math.round(chars / 3) + SYSTEM_OVERHEAD_TOKENS;
    outputTokens += Math.round(chars / 6) + 200;
  }
  if (type !== 'text') {
    etaSeconds += LAYOUT_SECONDS * pages;
    tariffEur += LAYOUT_BASE_EUR * pages;
    formulaParts.push(`макет: ${pages} стр × 0,80 € = ${(LAYOUT_BASE_EUR * pages).toFixed(2)} €`);
    inputTokens += (IMAGE_TOKENS_IN + SYSTEM_OVERHEAD_TOKENS) * pages;
    outputTokens += IMAGE_TOKENS_OUT * pages;
  }

  const tokenCostEur =
    ((inputTokens / 1_000_000) * USD_PER_MTOK_IN + (outputTokens / 1_000_000) * USD_PER_MTOK_OUT) * USD_TO_EUR;

  return {
    chars,
    etaMinutes: Math.max(1, Math.round(etaSeconds / 60)),
    priceEur: Math.round(tariffEur * 100) / 100,
    breakdown: {
      model: MODEL,
      inputTokens,
      outputTokens,
      tokenCostEur: Math.round(tokenCostEur * 10000) / 10000,
      modelPriceInUsdPerMTok: USD_PER_MTOK_IN,
      modelPriceOutUsdPerMTok: USD_PER_MTOK_OUT,
      tariffEur: Math.round(tariffEur * 100) / 100,
      formula: formulaParts.join(' + '),
    },
  };
}
