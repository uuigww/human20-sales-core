/**
 * Конфиг моделей. Модель — сменный «движок» через AI Gateway.
 * Сила продажника зашита в playbook/оркестрацию, а не в конкретного провайдера,
 * поэтому модель можно менять под выгодную по цене/качеству без правок логики.
 *
 * Строка модели в формате "creator/model" роутится через Vercel AI Gateway
 * (нужен AI_GATEWAY_API_KEY). Можно также использовать прямые ключи провайдеров.
 */

import 'dotenv/config';

export interface ModelConfig {
  /** Модель «мозга» продаж — основной диалог. Качество важнее цены. */
  sales: string;
  /** Модель LLM-судьи для eval. Можно дешевле — она лишь оценивает. */
  judge: string;
  /** Температура диалога. Невысокая: продажник дисциплинирован, но живой. */
  temperature: number;
  /** Сколько раз перегенерировать ответ при нарушении guardrails. */
  maxGuardrailRetries: number;
  /** Кап выходных токенов — ответ не может «взорваться» по стоимости. */
  maxOutputTokens: number;
  /** Усилие reasoning для reasoning-моделей (gpt-5 и т.п.). low = дёшево и достаточно для продаж. */
  reasoningEffort?: string;
}

/**
 * Дефолт без Claude (его API дорогое). Выгодный баланс качества/цены для продажи на русском +
 * строгое следование границам. Цены ≈ май 2026 за 1M токенов (in/out):
 *   - sales: GPT-5 mini (~$0.25/$2.00) — лучшее в дешёвом классе следование строгим инструкциям + русский.
 *   - judge: тоже OpenAI по умолчанию, чтобы всё работало с одним ключом (OPENAI_API_KEY).
 *            Если добавишь gateway/Google-ключ — поставь 'google/gemini-2.5-flash' для независимости оценки.
 *
 * Альтернативы (меняются через .env, код не трогаем):
 *   - 'google/gemini-2.5-flash'      — почти то же по цене/качеству, что GPT-5 mini; огромный контекст.
 *   - 'deepseek/deepseek-v4'         — ультра-дёшево (~$0.14 in). Русский ок, дисциплина границ/тон чуть
 *                                       слабее → ОБЯЗАТЕЛЬНО прогнать `npm run eval` перед продом.
 *   - 'google/gemini-2.5-flash-lite' — самый дешёвый (~$0.10/$0.40) для огромного объёма FAQ.
 *   - 'anthropic/claude-sonnet-4-6'  — если позже захочешь максимум качества, не меняя код.
 *
 * Методика выбора: бери самую дешёвую модель, которая проходит eval на 100% по границам.
 * Наши guardrails (цены/ссылки/scope) детерминированы — они страхуют даже дешёвую модель.
 */
const DEFAULT_SALES_MODEL = 'openai/gpt-5-mini';
const DEFAULT_JUDGE_MODEL = 'openai/gpt-5-mini';

export const models: ModelConfig = {
  sales: process.env.SALES_MODEL?.trim() || DEFAULT_SALES_MODEL,
  judge:
    process.env.JUDGE_MODEL?.trim() ||
    process.env.SALES_MODEL?.trim() ||
    DEFAULT_JUDGE_MODEL,
  temperature: 0.6,
  maxGuardrailRetries: 1,
  maxOutputTokens: 6000,
  reasoningEffort: process.env.SALES_REASONING_EFFORT?.trim() || 'low',
};
