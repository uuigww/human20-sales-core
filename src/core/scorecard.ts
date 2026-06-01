/**
 * Scorecard лида — «умная» оценка для квалификации и сортировки горячих лидов в CRM.
 * Качественные поля заполняет модель (оценивает по фактам диалога); числовой composite
 * `computeLeadScore` считает код детерминированно — по нему сортируем лиды в Postgres.
 */

import type { InterestTariff, LeadState } from './leadState.js';

export type Hotness = 'cold' | 'warm' | 'hot';
export type Sentiment = 'positive' | 'neutral' | 'negative';

export interface Bant {
  budget: 'unknown' | 'none' | 'limited' | 'sufficient';
  authority: 'unknown' | 'influencer' | 'decision_maker';
  urgency: 'unknown' | 'low' | 'medium' | 'high';
  timeline: 'unknown' | 'now' | 'weeks' | 'later';
}

export interface DealPotential {
  /** Ожидаемый тариф. */
  tariff: InterestTariff;
  /** Ожидаемая сумма сделки в ₽ (0 = неизвестно). */
  estimatedValueRub: number;
}

export interface Scorecard {
  /** Заинтересованность 1–5. */
  interest: number;
  /** Горячесть (качественная оценка модели). */
  hotness: Hotness;
  bant: Bant;
  sentiment: Sentiment;
  /** Флаги риска: 'troll' | 'time_waster' | ... (накапливаются). */
  riskFlags: string[];
  /** Главные барьеры к покупке (текущие). */
  barriers: string[];
  /** Рекомендация следующего шага — для менеджера. */
  nextBestAction: string;
  dealPotential: DealPotential;
  /** Резюме намерения одной строкой. */
  intentSummary: string;
}

/** Частичный апдейт scorecard от модели (всё опционально, bant/dealPotential — вложенно). */
export interface ScorecardUpdate {
  interest?: number;
  hotness?: Hotness;
  bant?: Partial<Bant>;
  sentiment?: Sentiment;
  riskFlags?: string[];
  barriers?: string[];
  nextBestAction?: string;
  dealPotential?: Partial<DealPotential>;
  intentSummary?: string;
}

export function defaultScorecard(): Scorecard {
  return {
    interest: 1,
    hotness: 'cold',
    bant: { budget: 'unknown', authority: 'unknown', urgency: 'unknown', timeline: 'unknown' },
    sentiment: 'neutral',
    riskFlags: [],
    barriers: [],
    nextBestAction: '',
    dealPotential: { tariff: 'unknown', estimatedValueRub: 0 },
    intentSummary: '',
  };
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const key = it.trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(it.trim());
    }
  }
  return out;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Слияние апдейта в scorecard (без мутаций входа). riskFlags копятся, barriers заменяются. */
export function mergeScorecard(cur: Scorecard, upd: ScorecardUpdate): Scorecard {
  return {
    interest: typeof upd.interest === 'number' ? clamp(Math.round(upd.interest), 1, 5) : cur.interest,
    hotness: upd.hotness ?? cur.hotness,
    bant: { ...cur.bant, ...(upd.bant ?? {}) },
    sentiment: upd.sentiment ?? cur.sentiment,
    riskFlags: upd.riskFlags?.length ? dedupe([...cur.riskFlags, ...upd.riskFlags]) : cur.riskFlags,
    barriers: upd.barriers ?? cur.barriers,
    nextBestAction: upd.nextBestAction ?? cur.nextBestAction,
    dealPotential: { ...cur.dealPotential, ...(upd.dealPotential ?? {}) },
    intentSummary: upd.intentSummary ?? cur.intentSummary,
  };
}

/**
 * Детерминированный composite-score 0–100 для сортировки горячих лидов.
 * Веса: интерес 30 · бюджет 20 · полномочия 15 · срочность 15 · стадия 10 · контакт 5 · настроение ±5 · риск −20.
 */
export function computeLeadScore(state: LeadState): number {
  const sc = state.scorecard;
  let score = 0;

  score += ((clamp(sc.interest, 1, 5) - 1) / 4) * 30;

  score += { none: 0, limited: 10, sufficient: 20, unknown: 5 }[sc.bant.budget];
  score += { influencer: 8, decision_maker: 15, unknown: 4 }[sc.bant.authority];
  score += { low: 2, medium: 8, high: 15, unknown: 4 }[sc.bant.urgency];

  const stageW: Record<LeadState['stage'], number> = {
    greeting: 0,
    discovery: 3,
    routing: 5,
    value: 7,
    objection: 6,
    closing: 10,
    handoff: 8,
    parked: 2,
  };
  score += stageW[state.stage];

  if (state.contactCaptured) score += 5;
  if (sc.sentiment === 'positive') score += 5;
  if (sc.sentiment === 'negative') score -= 5;
  if (sc.riskFlags.some((f) => f === 'troll' || f === 'time_waster')) score -= 20;

  return clamp(Math.round(score), 0, 100);
}

/** Производная горячесть от числового score — для CRM-сортировки, рядом с качественной hotness. */
export function deriveHotness(score: number): Hotness {
  if (score >= 70) return 'hot';
  if (score >= 40) return 'warm';
  return 'cold';
}
