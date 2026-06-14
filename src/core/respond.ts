/**
 * Единый контракт core. Адаптеры каналов (сайт, TG, VK, MAX, чат) вызывают только это.
 *
 *   respond({ message, history, state }) -> { reply, actions, state, violations }
 *
 * Канал отвечает лишь за доставку: показать reply, исполнить actions (оплата/CRM/передача),
 * сохранить state и вернуть его следующим ходом. Вся логика продаж — здесь и в playbook.
 */

import { z } from 'zod';
import { assembleSystemPrompt, frameUserMessage, INJECTION_REMINDER } from './promptAssembler.js';
import { actionSchema, AUTONOMOUS_PAYMENT_TARIFFS, type Action } from './actions.js';
import {
  applyUpdate,
  createLeadState,
  type LeadState,
  type LeadStateUpdate,
} from './leadState.js';
import { checkGuardrails, correctionNote, type Violation } from './guardrails.js';
import { defaultProvider } from './llm/gateway.js';
import type { ChatMessage, LLMProvider, StructuredRequest } from './llm/provider.js';
import { defaultKnowledge, type KnowledgeProvider } from './knowledge/provider.js';
import { models } from '../../config/models.js';
import { HUMAN_HANDOFF_CONTACT, resolveLinkIds, type ResolvedLink } from '@human20/ssot';

const SEGMENTS = ['unknown', 'solo', 'business', 'founder', 'company'] as const;
const STAGES = [
  'greeting',
  'discovery',
  'routing',
  'value',
  'objection',
  'closing',
  'handoff',
  'parked',
] as const;
const TARIFFS = ['workshop', 'dfy', 'custom', 'enterprise', 'sreda', 'unknown'] as const;

const scorecardUpdateSchema = z.object({
  interest: z.number().min(1).max(5).optional(),
  hotness: z.enum(['cold', 'warm', 'hot']).optional(),
  bant: z
    .object({
      budget: z.enum(['unknown', 'none', 'limited', 'sufficient']).optional(),
      authority: z.enum(['unknown', 'influencer', 'decision_maker']).optional(),
      urgency: z.enum(['unknown', 'low', 'medium', 'high']).optional(),
      timeline: z.enum(['unknown', 'now', 'weeks', 'later']).optional(),
    })
    .optional(),
  sentiment: z.enum(['positive', 'neutral', 'negative']).optional(),
  riskFlags: z.array(z.string()).optional(),
  barriers: z.array(z.string()).optional(),
  nextBestAction: z.string().optional(),
  dealPotential: z
    .object({ tariff: z.enum(TARIFFS).optional(), estimatedValueRub: z.number().optional() })
    .optional(),
  intentSummary: z.string().optional(),
});

const stateUpdateSchema = z.object({
  segment: z.enum(SEGMENTS).optional(),
  stage: z.enum(STAGES).optional(),
  interestTariff: z.enum(TARIFFS).optional(),
  readiness: z.number().min(0).max(100).optional(),
  contactCaptured: z.boolean().optional(),
  addPains: z.array(z.string()).optional(),
  addObjections: z.array(z.string()).optional(),
  addNotes: z.array(z.string()).optional(),
  scorecard: scorecardUpdateSchema.optional(),
});

const responseSchema = z.object({
  reply: z.string().min(1),
  stateUpdate: stateUpdateSchema,
  actions: z.array(actionSchema),
  /** id ссылок из реестра links.ts, которые надо показать в этом ходу. [] если не нужно. */
  links: z.array(z.string()),
});

type ModelResponse = z.infer<typeof responseSchema>;

export interface RespondInput {
  /** Сообщение пользователя в этом ходу. */
  message: string;
  /** История диалога (без текущего сообщения). */
  history?: ChatMessage[];
  /** Состояние лида с прошлого хода (или пусто для нового диалога). */
  state?: LeadState;
  /** Подмена провайдера LLM (для тестов/оффлайна). */
  provider?: LLMProvider;
  /** Источник продуктовых знаний: дефолт — статика из @human20/ssot; на сервере — RAG из pgvector. */
  knowledge?: KnowledgeProvider;
  /** Вход помечен анти-инъекцией как soft: усилить ремайндер и записать note. */
  untrusted?: boolean;
}

export interface RespondResult {
  reply: string;
  actions: Action[];
  /** Ссылки из вайтлиста для показа (канал рендерит как текст/кнопки). */
  links: ResolvedLink[];
  state: LeadState;
  /** Сработавшие guardrails (для логирования/мониторинга). */
  violations: Violation[];
}

export async function respond(input: RespondInput): Promise<RespondResult> {
  const provider = input.provider ?? defaultProvider;
  const history = input.history ?? [];
  const baseState: LeadState = {
    ...(input.state ?? createLeadState()),
    turnCount: (input.state?.turnCount ?? 0) + 1,
  };

  const messages: ChatMessage[] = [
    ...history,
    { role: 'user', content: frameUserMessage(input.message) },
  ];
  const knowledge = input.knowledge ?? defaultKnowledge;
  const productContext = await knowledge.productContext(input.message);
  const baseSystem =
    assembleSystemPrompt(baseState, productContext) +
    (input.untrusted ? '\n\n' + INJECTION_REMINDER : '');

  let lastViolations: Violation[] = [];

  for (let attempt = 0; attempt <= models.maxGuardrailRetries; attempt++) {
    const system =
      attempt === 0
        ? baseSystem
        : `${baseSystem}\n\n# ПОПРАВКА\n${correctionNote(lastViolations)}`;

    let result: ModelResponse;
    try {
      result = await runStructuredWithRetry<ModelResponse>(provider, {
        system,
        messages,
        schema: responseSchema,
        schemaName: 'sales_turn',
        schemaDescription: 'Реплика продажника + обновление состояния лида + действия для канала',
        role: 'sales',
      });
    } catch (err) {
      // Сбой провайдера — безопасный фолбэк с передачей живому, диалог не падает.
      return safeFallback(baseState, `Сбой LLM: ${(err as Error).message}`);
    }

    const guard = checkGuardrails(result.reply, result.actions);
    lastViolations = guard.violations;

    if (guard.ok) {
      const { resolved, unknown } = resolveLinkIds(result.links ?? []);
      const update = result.stateUpdate as LeadStateUpdate;
      if (input.untrusted) {
        update.addNotes = [...(update.addNotes ?? []), '⚠ возможная инъекция во входящем сообщении'];
      }
      if (unknown.length) {
        update.addNotes = [...(update.addNotes ?? []), `модель запросила неизвестные ссылки: ${unknown.join(', ')}`];
      }
      const state = applyUpdate(baseState, update);
      return {
        reply: result.reply.trim(),
        actions: sanitizeActions(result.actions),
        links: resolved,
        state,
        violations: guard.violations,
      };
    }
  }

  // Перегенерации не помогли — безопасный фолбэк, чтобы не выдать нарушение пользователю.
  return safeFallback(baseState, 'guardrails: перегенерация не устранила hard-нарушение');
}

/** Убирает любые незаконные платёжные действия на всякий случай (двойная защита). */
function sanitizeActions(actions: Action[]): Action[] {
  return actions.filter((a) => {
    if (a.type === 'give_payment_link') {
      return a.tariff != null && AUTONOMOUS_PAYMENT_TARIFFS.includes(a.tariff);
    }
    return true;
  });
}

/**
 * Вызов LLM с повторами при сбое генерации структурного ответа. Дешёвые модели
 * (gpt-4o-mini и т.п.) стохастически промахиваются мимо строгой схемы — повторная
 * попытка обычно проходит. Без этого один промах ронял весь диалог в handoff.
 */
const GENERATION_ATTEMPTS = 3;
async function runStructuredWithRetry<T>(
  provider: LLMProvider,
  req: StructuredRequest<T>,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < GENERATION_ATTEMPTS; i++) {
    try {
      return await provider.runStructured<T>(req);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr as Error;
}

function safeFallback(state: LeadState, note: string): RespondResult {
  const nextState = applyUpdate(state, { stage: 'handoff', addNotes: [note] });
  return {
    reply:
      'Дай мне секунду — чтобы ответить тебе точно и ничего не напутать по условиям, лучше подключу ' +
      `нашего человека (${HUMAN_HANDOFF_CONTACT}). Он быстро поможет.`,
    actions: [{ type: 'handoff_human', reason: note }],
    links: resolveLinkIds(['manager']).resolved,
    state: nextState,
    violations: [],
  };
}
