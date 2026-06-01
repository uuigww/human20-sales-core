/**
 * AbuseGuard — защита от спама токенами. Срабатывает ДО вызова LLM, поэтому заблокированное
 * сообщение НЕ стоит ни одного токена. Все проверки детерминированные и дешёвые.
 *
 * Слои (по порядку): длина сообщения → флуд дублей → rate-лимит (мин/час/день) → дневной бюджет.
 * Хранилище счётчиков — in-memory по умолчанию (на инстанс). Для мультиинстанса вынеси Map в Redis,
 * реализовав тот же check() поверх общего хранилища; интерфейс решения не меняется.
 */

import { HUMAN_HANDOFF_CONTACT } from '@human20/ssot';

export interface AbuseLimits {
  /** Максимум сообщений в минуту на клиента. */
  perMinute: number;
  /** Максимум в час. */
  perHour: number;
  /** Максимум в сутки. */
  perDay: number;
  /** Дневной бюджет LLM-ответов на клиента (жёсткий потолок стоимости одного человека). */
  maxRepliesPerDay: number;
  /** Кап длины входящего сообщения (символы). */
  maxMessageChars: number;
  /** Сколько одинаковых сообщений подряд считать флудом и блокировать. */
  duplicateStreak: number;
}

export const DEFAULT_LIMITS: AbuseLimits = {
  perMinute: 20,
  perHour: 100,
  perDay: 300,
  maxRepliesPerDay: 40,
  maxMessageChars: 2000,
  duplicateStreak: 3,
};

export type AbuseReason =
  | 'too_long'
  | 'duplicate'
  | 'rate_minute'
  | 'rate_hour'
  | 'rate_day'
  | 'budget';

export interface AbuseDecision {
  allow: boolean;
  reason?: AbuseReason;
  /** Что показать пользователю вместо LLM-ответа (если заблокировано). */
  cannedReply?: string;
  /** Через сколько секунд можно повторить (для rate-лимитов). */
  retryAfterSec?: number;
}

interface Counters {
  events: number[]; // таймстемпы (ms) разрешённых сообщений за последние 24ч
  repliesDay: number; // потрачено бюджета сегодня
  dayKey: string; // текущий день (для сброса бюджета)
  lastNorm: string; // последнее нормализованное сообщение (для дублей)
  dupCount: number; // длина серии одинаковых подряд
}

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const CANNED: Record<AbuseReason, string> = {
  too_long: 'Сообщение великовато 🙂 Давай покороче, по сути — что для тебя сейчас главное?',
  duplicate: 'Я тут, на связи. Напиши, что именно подсказать — помогу.',
  rate_minute: 'Давай чуть помедленнее — отвечаю по одному сообщению за раз 🙂',
  rate_hour: 'Сегодня много общаемся — сделаем паузу и продолжим чуть позже?',
  rate_day: 'На сегодня достаточно — вернёмся завтра. Если срочно, напиши нашему человеку: ' + HUMAN_HANDOFF_CONTACT + '.',
  budget: 'Мы уже многое обсудили — чтобы ничего не упустить, дальше тебе быстрее поможет наш человек: ' + HUMAN_HANDOFF_CONTACT + '.',
};

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

export class AbuseGuard {
  private users = new Map<string, Counters>();
  private limits: AbuseLimits;

  constructor(
    /** Можно передать часть лимитов — остальное возьмётся из DEFAULT_LIMITS. */
    limits: Partial<AbuseLimits> = {},
    /** Инъекция времени — для тестов. */
    private now: () => number = () => Date.now(),
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /**
   * Проверяет, можно ли обрабатывать сообщение клиента. allow=false → НЕ зовём LLM,
   * показываем cannedReply. Счётчики тратятся только на разрешённых сообщениях.
   */
  check(customerId: string, message: string): AbuseDecision {
    const t = this.now();

    // 1) Длина — режем до любых счётчиков.
    if (message.length > this.limits.maxMessageChars) {
      return { allow: false, reason: 'too_long', cannedReply: CANNED.too_long };
    }

    const u = this.getOrInit(customerId, t);
    this.resetDayIfNeeded(u, t);

    // 2) Флуд дублей.
    const norm = normalize(message);
    if (norm === u.lastNorm) u.dupCount += 1;
    else {
      u.dupCount = 1;
      u.lastNorm = norm;
    }
    if (u.dupCount >= this.limits.duplicateStreak) {
      return { allow: false, reason: 'duplicate', cannedReply: CANNED.duplicate };
    }

    // 3) Rate-лимиты (sliding window).
    u.events = u.events.filter((e) => t - e < DAY);
    const inMinute = u.events.filter((e) => t - e < MIN).length;
    const inHour = u.events.filter((e) => t - e < HOUR).length;
    const inDay = u.events.length;

    if (inMinute >= this.limits.perMinute) {
      return { allow: false, reason: 'rate_minute', cannedReply: CANNED.rate_minute, retryAfterSec: 60 };
    }
    if (inHour >= this.limits.perHour) {
      return { allow: false, reason: 'rate_hour', cannedReply: CANNED.rate_hour, retryAfterSec: 600 };
    }
    if (inDay >= this.limits.perDay) {
      return { allow: false, reason: 'rate_day', cannedReply: CANNED.rate_day, retryAfterSec: 3600 };
    }

    // 4) Дневной бюджет LLM-ответов.
    if (u.repliesDay >= this.limits.maxRepliesPerDay) {
      return { allow: false, reason: 'budget', cannedReply: CANNED.budget };
    }

    // Разрешено — фиксируем расход.
    u.events.push(t);
    u.repliesDay += 1;
    return { allow: true };
  }

  private getOrInit(customerId: string, t: number): Counters {
    let u = this.users.get(customerId);
    if (!u) {
      u = { events: [], repliesDay: 0, dayKey: this.dayKey(t), lastNorm: '', dupCount: 0 };
      this.users.set(customerId, u);
    }
    return u;
  }

  private resetDayIfNeeded(u: Counters, t: number): void {
    const key = this.dayKey(t);
    if (u.dayKey !== key) {
      u.dayKey = key;
      u.repliesDay = 0;
    }
  }

  private dayKey(t: number): string {
    return new Date(t).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  }
}
