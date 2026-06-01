/**
 * Дефолт-реализация LLMProvider через Vercel AI SDK.
 *
 * Резолвер провайдера (без правок кода переключается через .env):
 *   - есть AI_GATEWAY_API_KEY → строка "creator/model" роутится через Vercel AI Gateway (любой провайдер);
 *   - иначе модель "openai/..." + OPENAI_API_KEY → прямой провайдер OpenAI;
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
  if (!_openai) _openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

/** Превращает строку модели в то, что принимает generateObject (строка для gateway или объект провайдера). */
function resolveModel(modelStr: string) {
  if (process.env.AI_GATEWAY_API_KEY) return modelStr; // через gateway
  if (modelStr.startsWith('openai/') && process.env.OPENAI_API_KEY) {
    return openaiProvider()(modelStr.slice('openai/'.length)); // прямой OpenAI
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
      // Стабильный system-префикс идёт первым → автоматический prompt caching у OpenAI
      // (скидка на повторный ввод) срабатывает без доп. настройки.
    });

    return object as T;
  }
}

/** Синглтон по умолчанию. */
export const defaultProvider = new GatewayProvider();
