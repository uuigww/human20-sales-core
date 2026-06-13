/**
 * PostgresStore — прод-реализация MemoryStore поверх Postgres (см. db/schema.sql).
 * Денормализует поля скоринга в колонки, чтобы менеджер выбирал горячих лидов обычным SQL.
 *
 * Пул `pg.Pool` инжектится снаружи (core не тянет pg в рантайме сам):
 *   import { Pool } from 'pg';
 *   const store = new PostgresStore(new Pool({ connectionString: process.env.DATABASE_URL }));
 *
 * В smoke не участвует (нужна живая БД) — покрыт typecheck.
 */

import type { Pool } from 'pg';
import type { MemoryStore, ConversationRecord } from '../memory.js';
import { computeLeadScore } from '../scorecard.js';

export class PostgresStore implements MemoryStore {
  constructor(private pool: Pool) {}

  async load(customerId: string): Promise<ConversationRecord | null> {
    const { rows } = await this.pool.query(
      'SELECT profile, state, history FROM leads WHERE customer_id = $1',
      [customerId],
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      customerId,
      profile: r.profile,
      state: r.state,
      history: r.history ?? [],
    };
  }

  async save(rec: ConversationRecord): Promise<void> {
    const sc = rec.state.scorecard;
    await this.pool.query(
      `INSERT INTO leads
         (customer_id, profile, state, history, segment, interest_tariff, interest, hotness, lead_score, contact, channels, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (customer_id) DO UPDATE SET
         profile=EXCLUDED.profile, state=EXCLUDED.state, history=EXCLUDED.history,
         segment=EXCLUDED.segment, interest_tariff=EXCLUDED.interest_tariff,
         interest=EXCLUDED.interest, hotness=EXCLUDED.hotness, lead_score=EXCLUDED.lead_score,
         contact=EXCLUDED.contact, channels=EXCLUDED.channels, updated_at=now()`,
      [
        rec.customerId,
        JSON.stringify(rec.profile),
        JSON.stringify(rec.state),
        JSON.stringify(rec.history),
        rec.state.segment,
        rec.state.interestTariff,
        sc.interest,
        sc.hotness,
        computeLeadScore(rec.state),
        rec.profile.contact ?? null,
        rec.profile.channels,
      ],
    );
  }

  async linkAlias(alias: string, customerId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO lead_aliases (alias, customer_id) VALUES ($1,$2)
       ON CONFLICT (alias) DO UPDATE SET customer_id=EXCLUDED.customer_id`,
      [alias, customerId],
    );
  }

  async resolveAlias(alias: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      'SELECT customer_id FROM lead_aliases WHERE alias = $1',
      [alias],
    );
    return rows.length ? (rows[0].customer_id as string) : null;
  }

  /** Горячие лиды для менеджера: сортировка по lead_score. */
  async listHotLeads(minScore = 60, limit = 50): Promise<HotLead[]> {
    const { rows } = await this.pool.query(
      `SELECT customer_id, segment, interest_tariff, interest, hotness, lead_score, contact, updated_at
         FROM leads
        WHERE lead_score >= $1
        ORDER BY lead_score DESC, updated_at DESC
        LIMIT $2`,
      [minScore, limit],
    );
    return rows as HotLead[];
  }
}

export interface HotLead {
  customer_id: string;
  segment: string | null;
  interest_tariff: string | null;
  interest: number | null;
  hotness: string | null;
  lead_score: number | null;
  contact: string | null;
  updated_at: string;
}
