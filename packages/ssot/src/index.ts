/**
 * @human20/ssot — единый источник правды по продукту «Человек 2.0».
 * Потребляют: core (типы для guardrails + нарратив для промпта) и серверный RAG (манифест).
 */

// Типизированные данные оффера (АВТОРИТЕТ для guardrails — цены/тарифы/границы).
export {
  type TariffId,
  type Tariff,
  VALID_PRICES_RUB,
  RESERVE_PRICES_RUB,
  TARIFFS,
  NEVER_PROMISE,
  HUMAN_HANDOFF_CONTACT,
  PAYMENT_METHOD,
} from './offer.js';

// Реестр ссылок (вайтлист) + хелперы валидации.
export {
  type LinkEntry,
  type ResolvedLink,
  LINKS,
  listLinks,
  linkCatalog,
  resolveLinkIds,
  extractUrlCandidates,
  isAllowedUrl,
  findUnlistedUrls,
} from './links.js';

// Манифест и загрузка нарратива для RAG / статического провайдера знаний.
export {
  type KnowledgeKind,
  type KnowledgeSource,
  KNOWLEDGE_SOURCES,
  readKnowledgeSource,
  knowledgeManifest,
  loadProductNarrative,
  loadOffer,
  loadBoundaries,
} from './manifest.js';
