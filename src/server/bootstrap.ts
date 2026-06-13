/**
 * Сборка зависимостей сервиса из переменных окружения. Переиспользует готовые блоки core —
 * сервер сам ничего не «изобретает», только выбирает реализацию по env.
 *
 *   DATABASE_URL задан  → PostgresStore (память в БД); иначе JsonFileStore (./data).
 *   USE_RAG=true + БД    → знания из pgvector (RagKnowledgeProvider); иначе статика из @human20/ssot.
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { createOpenAI } from '@ai-sdk/openai';
import { embed } from 'ai';
import {
  AbuseGuard,
  InjectionGuard,
  JsonFileStore,
  PostgresStore,
  StaticKnowledgeProvider,
  RagKnowledgeProvider,
  createPgVectorRetriever,
  type MemoryStore,
  type KnowledgeProvider,
} from '../index.js';

export interface Services {
  store: MemoryStore;
  guard: AbuseGuard;
  injectionGuard: InjectionGuard;
  knowledge: KnowledgeProvider;
  pool?: Pool;
  /** Краткое описание конфигурации для логов/healthcheck. */
  info: string;
}

export function buildServices(): Services {
  const guard = new AbuseGuard();
  const injectionGuard = new InjectionGuard();
  let store: MemoryStore;
  let knowledge: KnowledgeProvider = new StaticKnowledgeProvider();
  let pool: Pool | undefined;
  const bits: string[] = [];

  if (process.env.DATABASE_URL) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    store = new PostgresStore(pool);
    bits.push('store=postgres');

    if (process.env.USE_RAG === 'true') {
      const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const embedModel = process.env.EMBED_MODEL || 'text-embedding-3-small';
      const embedFn = async (text: string): Promise<number[]> =>
        (await embed({ model: openai.embedding(embedModel), value: text })).embedding;
      knowledge = new RagKnowledgeProvider(createPgVectorRetriever(pool, embedFn));
      bits.push('knowledge=rag');
    } else {
      bits.push('knowledge=static');
    }
  } else {
    store = new JsonFileStore(process.env.DATA_DIR || './data/customers');
    bits.push('store=jsonfile', 'knowledge=static');
  }

  bits.push(`model=${process.env.SALES_MODEL || 'openai/gpt-5-mini'}`);
  return { store, guard, injectionGuard, knowledge, pool, info: bits.join(' · ') };
}
