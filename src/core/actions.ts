/**
 * Действия, которые core просит выполнить адаптер канала.
 * Core не умеет (и не должен) сам слать платёжки/писать в CRM — он лишь решает,
 * ЧТО надо сделать, и возвращает это как структурные действия. Адаптер исполняет.
 */

import { z } from 'zod';
import type { TariffId } from '@human20/ssot';

export const ACTION_TYPES = [
  'give_payment_link', // дать ссылку/QR на оплату (только прямые тарифы)
  'offer_demo', // предложить демо-агента
  'add_to_waitlist', // записать в лист ожидания
  'capture_lead', // зафиксировать/обновить лид в единой базе
  'collect_200k_brief', // собрать анкету под персональную сборку
  'handoff_human', // передать живому человеку
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

/** Тарифы, которые боту разрешено закрывать оплатой автономно. */
export const AUTONOMOUS_PAYMENT_TARIFFS: readonly TariffId[] = ['workshop', 'sreda'];

export const actionSchema = z.object({
  type: z.enum(ACTION_TYPES),
  /** Тариф (для give_payment_link / collect_200k_brief). */
  tariff: z
    .enum(['workshop', 'dfy', 'custom', 'enterprise', 'sreda'])
    .optional(),
  /** Причина/контекст (для handoff_human и заметок адаптеру). */
  reason: z.string().optional(),
});

export type Action = z.infer<typeof actionSchema>;
