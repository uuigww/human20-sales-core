/**
 * Ретривер знаний из pgvector → подставляется в RagKnowledgeProvider.
 *   const retrieve = createPgVectorRetriever(pool, embed);
 *   const knowledge = new RagKnowledgeProvider(retrieve);
 * где embed(text) → number[] (например, OpenAI text-embedding-3-small, см. scripts/ingest-knowledge.ts).
 *
 * В smoke не участвует (нужна живая БД) — покрыт typecheck.
 */

import type { Pool } from 'pg';
import type { KnowledgeChunk, RetrieveFn } from './provider.js';

export type EmbedFn = (text: string) => Promise<number[]>;

export function createPgVectorRetriever(pool: Pool, embed: EmbedFn): RetrieveFn {
  return async (query: string, topK: number): Promise<KnowledgeChunk[]> => {
    const vec = await embed(query);
    const literal = `[${vec.join(',')}]`; // формат pgvector
    const { rows } = await pool.query(
      `SELECT title, content
         FROM knowledge_chunks
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
      [literal, topK],
    );
    return rows.map((r) => ({ title: r.title ?? undefined, content: r.content as string }));
  };
}
