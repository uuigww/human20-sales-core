/**
 * Модель состояния лида — живёт между репликами, передаётся каналом обратно в core.
 * Канал хранит её как угодно (в БД, в памяти) и отдаёт следующим вызовом respond().
 */

import type { TariffId } from '@human20/ssot';
import {
  type Scorecard,
  type ScorecardUpdate,
  defaultScorecard,
  mergeScorecard,
  computeLeadScore,
} from './scorecard.js';

export type Segment = 'unknown' | 'solo' | 'business' | 'founder' | 'company';

export type Stage =
  | 'greeting' // первый контакт
  | 'discovery' // диагностика
  | 'routing' // развилка по состоянию
  | 'value' // продажа ценности
  | 'objection' // отработка возражений
  | 'closing' // ведём к шагу/оплате
  | 'handoff' // передача живому
  | 'parked'; // отпустили без дожима (демо/лист ожидания)

export type InterestTariff = TariffId | 'unknown';

export interface LeadState {
  segment: Segment;
  stage: Stage;
  interestTariff: InterestTariff;
  /** Выявленные боли (короткие формулировки). */
  pains: string[];
  /** Поднятые возражения (для памяти диалога). */
  objectionsRaised: string[];
  /** Готовность к шагу, 0–100. Грубая оценка модели. */
  readiness: number;
  /** Захвачен ли контакт (почта/телефон/согласие) — главная цель омниканальности. */
  contactCaptured: boolean;
  /**
   * Зафиксирован ли scope для 48k (SKU/состав/сроки/VPS/выдача).
   * В рамках автономного диалога ВСЕГДА false — фиксирует только живой человек.
   * Поле существует для будущей интеграции с CRM/менеджером.
   */
  dfyScopeFixed: boolean;
  /** Произвольные заметки для живого человека при передаче. */
  notes: string[];
  /** Счётчик ходов (реплик пользователя). */
  turnCount: number;
  /** Умная карточка лида: интерес, горячесть, BANT, тональность, барьеры, NBA, потенциал. */
  scorecard: Scorecard;
}

export function createLeadState(partial: Partial<LeadState> = {}): LeadState {
  return {
    segment: 'unknown',
    stage: 'greeting',
    interestTariff: 'unknown',
    pains: [],
    objectionsRaised: [],
    readiness: 0,
    contactCaptured: false,
    dfyScopeFixed: false,
    notes: [],
    turnCount: 0,
    scorecard: defaultScorecard(),
    ...partial,
  };
}

/** Частичное обновление состояния, которое модель возвращает каждым ходом. */
export interface LeadStateUpdate {
  segment?: Segment;
  stage?: Stage;
  interestTariff?: InterestTariff;
  readiness?: number;
  contactCaptured?: boolean;
  addPains?: string[];
  addObjections?: string[];
  addNotes?: string[];
  scorecard?: ScorecardUpdate;
}

/** Чистое применение апдейта к состоянию (без мутаций входа). */
export function applyUpdate(state: LeadState, update: LeadStateUpdate): LeadState {
  const next: LeadState = {
    ...state,
    pains: [...state.pains],
    objectionsRaised: [...state.objectionsRaised],
    notes: [...state.notes],
  };

  if (update.segment) next.segment = update.segment;
  if (update.stage) next.stage = update.stage;
  if (update.interestTariff) next.interestTariff = update.interestTariff;
  if (typeof update.readiness === 'number') {
    next.readiness = Math.max(0, Math.min(100, Math.round(update.readiness)));
  }
  if (typeof update.contactCaptured === 'boolean') {
    next.contactCaptured = update.contactCaptured;
  }
  if (update.addPains?.length) next.pains = dedupe([...next.pains, ...update.addPains]);
  if (update.addObjections?.length) {
    next.objectionsRaised = dedupe([...next.objectionsRaised, ...update.addObjections]);
  }
  if (update.addNotes?.length) next.notes = dedupe([...next.notes, ...update.addNotes]);
  if (update.scorecard) next.scorecard = mergeScorecard(state.scorecard, update.scorecard);

  return next;
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(item.trim());
    }
  }
  return out;
}

/** Короткая сводка состояния для инъекции в промпт. */
export function summarizeState(state: LeadState): string {
  const lines = [
    `сегмент: ${state.segment}`,
    `стадия: ${state.stage}`,
    `интерес-тариф: ${state.interestTariff}`,
    `готовность: ${state.readiness}/100`,
    `контакт захвачен: ${state.contactCaptured ? 'да' : 'нет'}`,
    `scope 48k зафиксирован: ${state.dfyScopeFixed ? 'да' : 'нет (закрывать 48k нельзя, только передача живому)'}`,
    `ход №: ${state.turnCount}`,
  ];
  if (state.pains.length) lines.push(`боли: ${state.pains.join('; ')}`);
  if (state.objectionsRaised.length) {
    lines.push(`возражения уже были: ${state.objectionsRaised.join('; ')}`);
  }
  if (state.notes.length) lines.push(`заметки: ${state.notes.join('; ')}`);

  const sc = state.scorecard;
  lines.push(
    `— scorecard —`,
    `интерес: ${sc.interest}/5 · горячесть: ${sc.hotness} · score: ${computeLeadScore(state)}/100`,
    `BANT: бюджет=${sc.bant.budget}, полномочия=${sc.bant.authority}, срочность=${sc.bant.urgency}, сроки=${sc.bant.timeline}`,
    `настроение: ${sc.sentiment}${sc.riskFlags.length ? ` · риск: ${sc.riskFlags.join(', ')}` : ''}`,
    `потенциал: ${sc.dealPotential.tariff}${sc.dealPotential.estimatedValueRub ? ` (~${sc.dealPotential.estimatedValueRub}₽)` : ''}`,
  );
  if (sc.barriers.length) lines.push(`барьеры: ${sc.barriers.join('; ')}`);
  if (sc.nextBestAction) lines.push(`next best action: ${sc.nextBestAction}`);
  if (sc.intentSummary) lines.push(`намерение: ${sc.intentSummary}`);
  return lines.join('\n');
}
