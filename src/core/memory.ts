/**
 * Память по клиентам. Core помнит КАЖДОГО клиента между сообщениями и между визитами,
 * а через единый customerId — и в разных каналах (Telegram / VK / MAX / сайт).
 *
 * Идентификация:
 *  - У каждого канала есть свой нативный id (tg user id, vk id, web session). Из него делаем
 *    стабильный customerId = "<channel>:<nativeId>".
 *  - Чтобы «склеить» одного человека из двух каналов — алиасы: по контакту (email/телефон),
 *    который он дал, или по одноразовому код-токену (mintLinkCode → redeemLinkCode).
 *
 * Хранилище — интерфейс MemoryStore. Дефолт: InMemoryStore (dev) и JsonFileStore (локально/прод-лайт).
 * Для прод/мультиинстанса реализуй тот же интерфейс на Redis/Postgres — остальной код не меняется.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { respond, type RespondResult } from './respond.js';
import { createLeadState, type LeadState } from './leadState.js';
import type { ChatMessage, LLMProvider } from './llm/provider.js';
import type { AbuseGuard, AbuseReason } from './abuseGuard.js';
import type { KnowledgeProvider } from './knowledge/provider.js';
import { resolveLinkIds } from '@human20/ssot';

export interface CustomerProfile {
  displayName?: string;
  /** Контакт, если дал (email/телефон) — ключ для кросс-канальной склейки. */
  contact?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Через какие каналы приходил. */
  channels: string[];
}

export interface ConversationRecord {
  customerId: string;
  state: LeadState;
  history: ChatMessage[];
  profile: CustomerProfile;
}

export interface MemoryStore {
  load(customerId: string): Promise<ConversationRecord | null>;
  save(rec: ConversationRecord): Promise<void>;
  /** Привязать алиас (contact:..., code:...) к customerId. */
  linkAlias(alias: string, customerId: string): Promise<void>;
  /** Найти customerId по алиасу. */
  resolveAlias(alias: string): Promise<string | null>;
}

/** Стабильный id клиента из канала и нативного id. */
export function makeCustomerId(channel: string, nativeId: string | number): string {
  return `${channel}:${nativeId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function newRecord(customerId: string, channel: string): ConversationRecord {
  const ts = nowIso();
  return {
    customerId,
    state: createLeadState(),
    history: [],
    profile: { firstSeenAt: ts, lastSeenAt: ts, channels: [channel] },
  };
}

// ---------- Хранилища ----------

export class InMemoryStore implements MemoryStore {
  private records = new Map<string, ConversationRecord>();
  private aliases = new Map<string, string>();

  async load(customerId: string): Promise<ConversationRecord | null> {
    return this.records.get(customerId) ?? null;
  }
  async save(rec: ConversationRecord): Promise<void> {
    this.records.set(rec.customerId, rec);
  }
  async linkAlias(alias: string, customerId: string): Promise<void> {
    this.aliases.set(alias, customerId);
  }
  async resolveAlias(alias: string): Promise<string | null> {
    return this.aliases.get(alias) ?? null;
  }
}

/** Простое файловое хранилище: по файлу на клиента + aliases.json. Для локали/прод-лайт. */
export class JsonFileStore implements MemoryStore {
  private aliasesFile: string;
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
    this.aliasesFile = join(dir, '_aliases.json');
  }
  private file(customerId: string): string {
    return join(this.dir, customerId.replace(/[^a-zA-Z0-9_.-]/g, '_') + '.json');
  }
  async load(customerId: string): Promise<ConversationRecord | null> {
    const f = this.file(customerId);
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, 'utf8')) as ConversationRecord;
  }
  async save(rec: ConversationRecord): Promise<void> {
    writeFileSync(this.file(rec.customerId), JSON.stringify(rec, null, 2), 'utf8');
  }
  private readAliases(): Record<string, string> {
    return existsSync(this.aliasesFile)
      ? (JSON.parse(readFileSync(this.aliasesFile, 'utf8')) as Record<string, string>)
      : {};
  }
  async linkAlias(alias: string, customerId: string): Promise<void> {
    const a = this.readAliases();
    a[alias] = customerId;
    writeFileSync(this.aliasesFile, JSON.stringify(a, null, 2), 'utf8');
  }
  async resolveAlias(alias: string): Promise<string | null> {
    return this.readAliases()[alias] ?? null;
  }
}

// ---------- Высокоуровневый обработчик сообщения ----------

export interface ConverseInput {
  store: MemoryStore;
  channel: string;
  /** Нативный id пользователя в канале. */
  userId: string | number;
  message: string;
  provider?: LLMProvider;
  /** Сколько последних сообщений слать модели (экономия токенов). Хранится всё. */
  historyWindow?: number;
  /** Анти-спам/анти-абуз. Если задан — проверяется ДО вызова LLM (заблокированное = 0 токенов). */
  guard?: AbuseGuard;
  /** Источник знаний (статика/RAG). Прокидывается в respond(). */
  knowledge?: KnowledgeProvider;
}

export interface ConverseResult extends RespondResult {
  customerId: string;
  /** Если сообщение заблокировано guard'ом — код причины (LLM не вызывался). */
  blocked?: AbuseReason;
}

/**
 * Одна точка для адаптера канала: загружает память клиента → отвечает → сохраняет.
 * Адаптеру остаётся показать reply/links и исполнить actions.
 */
export async function converse(input: ConverseInput): Promise<ConverseResult> {
  const { store, channel, userId, message, provider, guard, knowledge } = input;
  const customerId = makeCustomerId(channel, userId);

  const rec = (await store.load(customerId)) ?? newRecord(customerId, channel);

  // Анти-спам ДО LLM: заблокированное сообщение не стоит токенов и не сохраняется.
  if (guard) {
    const d = guard.check(customerId, message);
    if (!d.allow) {
      const handoff = d.reason === 'budget' || d.reason === 'rate_day';
      return {
        reply: d.cannedReply ?? 'Давай чуть помедленнее 🙂',
        actions: handoff ? [{ type: 'handoff_human', reason: `abuse:${d.reason}` }] : [],
        links: handoff ? resolveLinkIds(['manager']).resolved : [],
        state: rec.state,
        violations: [],
        customerId,
        blocked: d.reason,
      };
    }
  }

  const window = input.historyWindow ?? 12;
  const recentHistory = rec.history.slice(-window);

  const result = await respond({ message, history: recentHistory, state: rec.state, provider, knowledge });

  rec.state = result.state;
  rec.history.push({ role: 'user', content: message });
  rec.history.push({ role: 'assistant', content: result.reply });
  rec.profile.lastSeenAt = nowIso();
  if (!rec.profile.channels.includes(channel)) rec.profile.channels.push(channel);
  await store.save(rec);

  return { ...result, customerId };
}

// ---------- Кросс-канальная склейка ----------

/** Привязать клиента по контакту (email/телефон). Адаптер зовёт это, когда контакт получен. */
export async function linkByContact(store: MemoryStore, contact: string, customerId: string): Promise<void> {
  await store.linkAlias('contact:' + contact.trim().toLowerCase(), customerId);
}

/** Найти ранее известного клиента по контакту (например, пришёл в новый канал с тем же email). */
export function findByContact(store: MemoryStore, contact: string): Promise<string | null> {
  return store.resolveAlias('contact:' + contact.trim().toLowerCase());
}

/** Выдать одноразовый код-токен для связки аккаунтов между каналами. */
export async function mintLinkCode(store: MemoryStore, customerId: string): Promise<string> {
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  await store.linkAlias('code:' + code, customerId);
  return code;
}

/** Погасить код в другом канале → вернёт customerId исходного клиента (для переноса памяти). */
export function redeemLinkCode(store: MemoryStore, code: string): Promise<string | null> {
  return store.resolveAlias('code:' + code.trim().toUpperCase());
}

/** Перенести профиль/состояние от одного customerId к другому (склейка истории по решению адаптера). */
export async function mergeFrom(store: MemoryStore, fromCustomerId: string, into: ConversationRecord): Promise<void> {
  const src = await store.load(fromCustomerId);
  if (!src) return;
  into.profile.firstSeenAt =
    src.profile.firstSeenAt < into.profile.firstSeenAt ? src.profile.firstSeenAt : into.profile.firstSeenAt;
  into.profile.contact = into.profile.contact ?? src.profile.contact;
  into.profile.displayName = into.profile.displayName ?? src.profile.displayName;
  for (const ch of src.profile.channels) if (!into.profile.channels.includes(ch)) into.profile.channels.push(ch);
  // переносим выявленные боли/заметки, если у новой записи пусто
  if (into.state.pains.length === 0) into.state.pains = [...src.state.pains];
  if (into.state.notes.length === 0) into.state.notes = [...src.state.notes];
  await store.save(into);
}

/** Список всех клиентов в файловом хранилище (для аналитики/CRM-экспорта). */
export function listCustomerFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json') && f !== '_aliases.json');
}
