/**
 * Провайдер-агностичный интерфейс LLM. Core зависит только от него, а не от конкретного
 * SDK/провайдера — поэтому модель меняется конфигом, а реализацию можно подменить (тесты, оффлайн).
 */

import type { z } from 'zod';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StructuredRequest<T> {
  /** Собранный system prompt (персона + знания + playbook + состояние + границы). */
  system: string;
  /** История диалога в порядке возрастания. */
  messages: ChatMessage[];
  /** Zod-схема ожидаемого структурного ответа. */
  schema: z.ZodType<T>;
  schemaName?: string;
  schemaDescription?: string;
  /** Какая модель: 'sales' (диалог) или 'judge' (eval). */
  role?: 'sales' | 'judge';
  temperature?: number;
}

export interface LLMProvider {
  runStructured<T>(req: StructuredRequest<T>): Promise<T>;
}
