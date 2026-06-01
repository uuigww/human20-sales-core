-- Схема БД «Человек 2.0» — лиды + RAG-знания в одном Postgres (pgvector).
-- Применить: psql "$DATABASE_URL" -f db/schema.sql
-- Требует расширение pgvector (на managed-Postgres обычно включается из коробки).

CREATE EXTENSION IF NOT EXISTS vector;

-- ── Лиды (единая база, память по клиентам) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS leads (
  customer_id      text PRIMARY KEY,         -- "<channel>:<nativeId>"
  profile          jsonb NOT NULL,           -- CustomerProfile
  state            jsonb NOT NULL,           -- LeadState (вкл. scorecard)
  history          jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- денормализованные поля скоринга для быстрых выборок горячих лидов:
  segment          text,
  interest_tariff  text,
  interest         smallint,                 -- 1..5
  hotness          text,                     -- cold|warm|hot
  lead_score       smallint,                 -- 0..100 (computeLeadScore)
  contact          text,
  channels         text[],
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leads_score   ON leads (lead_score DESC);
CREATE INDEX IF NOT EXISTS idx_leads_hotness ON leads (hotness);
CREATE INDEX IF NOT EXISTS idx_leads_segment ON leads (segment);

-- Кросс-канальные алиасы (контакт/код-токен → customer_id)
CREATE TABLE IF NOT EXISTS lead_aliases (
  alias        text PRIMARY KEY,             -- 'contact:email' | 'code:ABC123'
  customer_id  text NOT NULL
);

-- ── RAG-знания по проекту (pgvector) ───────────────────────────────────────
-- Размерность 1536 = OpenAI text-embedding-3-small. Под другую модель — поменять число.
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id          bigserial PRIMARY KEY,
  source_id   text NOT NULL,                 -- id из манифеста @human20/ssot
  title       text,
  content     text NOT NULL,
  embedding   vector(1536)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_embedding
  ON knowledge_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Пример выборки горячих лидов для менеджера:
--   SELECT customer_id, segment, interest, hotness, lead_score, contact
--   FROM leads WHERE lead_score >= 60 ORDER BY lead_score DESC, updated_at DESC LIMIT 50;
