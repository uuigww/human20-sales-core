/**
 * Индексация знаний проекта в pgvector для RAG.
 *   npm run ingest
 * Требует DATABASE_URL (Postgres c pgvector, схема применена) и OPENAI_API_KEY.
 *
 * Берёт источники из манифеста @human20/ssot, чанкует, считает эмбеддинги (text-embedding-3-small,
 * 1536 dim — совпадает с db/schema.sql) и перезаписывает knowledge_chunks по каждому source_id.
 * Добавил документ в манифест ssot → перезапустил этот скрипт → RAG обновлён.
 */

import 'dotenv/config';
import pg from 'pg';
import { embedMany } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { knowledgeManifest } from '@human20/ssot';

const EMBED_MODEL = 'text-embedding-3-small'; // 1536 dim
const MAX_CHARS = 1400;

function chunk(text: string): string[] {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let buf = '';
  for (const p of paras) {
    if (buf && (buf + '\n\n' + p).length > MAX_CHARS) {
      out.push(buf);
      buf = p;
    } else {
      buf = buf ? buf + '\n\n' + p : p;
    }
  }
  if (buf) out.push(buf);
  return out;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Нужен DATABASE_URL');
  if (!process.env.OPENAI_API_KEY) throw new Error('Нужен OPENAI_API_KEY');

  const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = openai.embedding(EMBED_MODEL);
  const pool = new pg.Pool({ connectionString });

  try {
    const sources = knowledgeManifest();
    let total = 0;

    for (const src of sources) {
      const chunks = chunk(src.content);
      const { embeddings } = await embedMany({ model, values: chunks });

      await pool.query('DELETE FROM knowledge_chunks WHERE source_id = $1', [src.id]);
      for (let i = 0; i < chunks.length; i++) {
        const literal = `[${embeddings[i]!.join(',')}]`;
        await pool.query(
          `INSERT INTO knowledge_chunks (source_id, title, content, embedding)
           VALUES ($1, $2, $3, $4::vector)`,
          [src.id, src.title, chunks[i], literal],
        );
      }
      console.log(`  ✓ ${src.id}: ${chunks.length} чанков`);
      total += chunks.length;
    }

    console.log(`\nГотово: ${total} чанков из ${sources.length} источников.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Ingest упал:', err);
  process.exit(1);
});
