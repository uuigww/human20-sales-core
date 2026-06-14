/**
 * Дефолт-реализация LLMProvider через Vercel AI SDK.
 *
 * Резолвер провайдера (без правок кода переключается через .env):
 *   - есть AI_GATEWAY_API_KEY → строка "creator/model" роутится через Vercel AI Gateway (любой провайдер);
 *   - есть OPENAI_BASE_URL (OpenAI-совместимый прокси: OpenRouter/litellm) → полный slug "creator/model"
 *     уходит на этот baseURL с OPENAI_API_KEY как bearer;
 *   - иначе модель "openai/..." + OPENAI_API_KEY → прямой провайдер OpenAI (срезаем префикс);
 *   - иначе строка отдаётся как есть (AI SDK сам решит / выдаст понятную ошибку).
 *
 * Сменить модель = поменять SALES_MODEL в .env / config/models.ts.
 */

import { generateObject } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { models } from '../../../config/models.js';
import type { LLMProvider, StructuredRequest } from './provider.js';

let _openai: ReturnType<typeof createOpenAI> | null = null;
function openaiProvider() {
  if (!_openai)
    _openai = createOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      // OpenAI-совместимый baseURL (OpenRouter/litellm/любой прокси). Пусто → дефолт api.openai.com.
      baseURL: process.env.OPENAI_BASE_URL || undefined,
    });
  return _openai;
}

/** Превращает строку модели в то, что принимает generateObject (строка для gateway или объект провайдера). */
function resolveModel(modelStr: string) {
  if (process.env.AI_GATEWAY_API_KEY) return modelStr; // через Vercel AI Gateway
  if (process.env.OPENAI_API_KEY) {
    // OpenRouter-совместимый режим (кастомный baseURL): провайдер ждёт ПОЛНЫЙ slug "creator/model".
    // Прямой OpenAI: api.openai.com ждёт чистое имя — срезаем префикс openai/.
    const id = process.env.OPENAI_BASE_URL
      ? modelStr
      : modelStr.startsWith("openai/")
        ? modelStr.slice("openai/".length)
        : null;
    // structuredOutputs:true → strict JSON Schema (модель НЕ пропускает required и держит enum).
    // Каст: d.ts провайдера отстаёт от рантайм-API .chat(id, settings) — проверено живьём.
    if (id !== null) {
      const chat = openaiProvider().chat as (m: string, s?: { structuredOutputs?: boolean }) => ReturnType<ReturnType<typeof createOpenAI>>;
      return chat(id, { structuredOutputs: true });
    }
  }
  return modelStr;
}

export class GatewayProvider implements LLMProvider {
  async runStructured<T>(req: StructuredRequest<T>): Promise<T> {
    const modelStr = req.role === 'judge' ? models.judge : models.sales;
    const temperature = req.temperature ?? models.temperature;

    const { object } = await generateObject({
      model: resolveModel(modelStr),
      schema: req.schema,
      schemaName: req.schemaName,
      schemaDescription: req.schemaDescription,
      system: req.system,
      messages: req.messages,
      temperature,
      maxOutputTokens: models.maxOutputTokens,
      // reasoning-модели (gpt-5*): ограничиваем глубину рассуждений — иначе reasoning съедает
      // весь бюджет вывода и структурный объект не достраивается (finish_reason=length).
      ...(models.reasoningEffort
        ? { providerOptions: { openai: { reasoningEffort: models.reasoningEffort } } }
        : {}),
      // Стабильный system-префикс идёт первым → автоматический prompt caching у OpenAI
      // (скидка на повторный ввод) срабатывает без доп. настройки.
    });

    return object as T;
  }
}

/** Синглтон по умолчанию. */
export const defaultProvider = new GatewayProvider();
