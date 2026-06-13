/**
 * Публичный API core для адаптеров каналов.
 * Адаптер импортирует отсюда — внутренняя структура может меняться.
 */

export { respond } from './core/respond.js';
export type { RespondInput, RespondResult } from './core/respond.js';
export { createLeadState, summarizeState } from './core/leadState.js';
export type { LeadState, Segment, Stage, InterestTariff } from './core/leadState.js';
export {
  computeLeadScore,
  deriveHotness,
  defaultScorecard,
  type Scorecard,
  type Hotness,
  type Sentiment,
  type Bant,
  type DealPotential,
} from './core/scorecard.js';
export type { Action, ActionType } from './core/actions.js';
export type { ChatMessage, LLMProvider } from './core/llm/provider.js';
export { GatewayProvider, defaultProvider } from './core/llm/gateway.js';
export {
  TARIFFS,
  HUMAN_HANDOFF_CONTACT,
  LINKS,
  listLinks,
  type ResolvedLink,
  type LinkEntry,
  type TariffId,
} from '@human20/ssot';
export {
  converse,
  makeCustomerId,
  InMemoryStore,
  JsonFileStore,
  linkByContact,
  findByContact,
  mintLinkCode,
  redeemLinkCode,
  mergeFrom,
  type MemoryStore,
  type ConversationRecord,
  type CustomerProfile,
  type ConverseInput,
  type ConverseResult,
} from './core/memory.js';
export {
  AbuseGuard,
  DEFAULT_LIMITS,
  type AbuseLimits,
  type AbuseDecision,
  type AbuseReason,
} from './core/abuseGuard.js';
export {
  InjectionGuard,
  scanText,
  INJECTION_PATTERNS,
  DEFAULT_INJECTION_LIMITS,
  type InjectionLimits,
  type InjectionDecision,
  type InjectionSeverity,
  type InjectionPattern,
} from './core/injectionGuard.js';
export { sanitizeKnowledgeChunk, type SanitizeResult } from './core/knowledge/sanitize.js';
export { frameUserMessage, INPUT_TRUST_NOTE, INJECTION_REMINDER } from './core/promptAssembler.js';
export {
  type KnowledgeProvider,
  StaticKnowledgeProvider,
  RagKnowledgeProvider,
  defaultKnowledge,
  type KnowledgeChunk,
  type RetrieveFn,
} from './core/knowledge/provider.js';
export {
  knowledgeManifest,
  KNOWLEDGE_SOURCES,
  loadOffer,
  loadBoundaries,
  type KnowledgeSource,
} from '@human20/ssot';
export { PostgresStore } from './core/stores/postgresStore.js';
export { createPgVectorRetriever, type EmbedFn } from './core/knowledge/pgVectorRetriever.js';
