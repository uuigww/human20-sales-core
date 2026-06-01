/**
 * SSOT оффера в типизированном виде — для программных guardrails
 * (проверка цен, scope-гейтов, автономности закрытия).
 *
 * Нарративная версия (для промпта/людей) — в offer.md. Они должны совпадать.
 * Источник: Human20_позиционирование_линейки.md §2-3, маркетинг-план §3, §34.
 *
 * ⚠️ Менять цены/состав ТОЛЬКО здесь и в offer.md одновременно (governance §4Б).
 */

export type TariffId = 'workshop' | 'dfy' | 'custom' | 'enterprise' | 'sreda';

export interface Tariff {
  id: TariffId;
  /** Публичное название (как называет бот). */
  name: string;
  /** Цена в рублях. null = «от/по заявке», точную цену бот не называет кнопкой. */
  priceRub: number | null;
  /** Как подаётся цена в тексте. */
  priceLabel: string;
  /** Можно ли боту закрывать сделку автономно (вести до оплаты). */
  canCloseAutonomously: boolean;
  /** Требуется ли зафиксированный scope перед закрытием (актуально для 48k). */
  requiresFixedScope: boolean;
  /** Требуется ли передача живому человеку (high-ticket). */
  requiresHumanHandoff: boolean;
}

/** Все валидные цены, которые боту разрешено называть. Защита от галлюцинаций цены. */
export const VALID_PRICES_RUB: readonly number[] = [
  1800, // Среда / мес
  18000, // воркшоп presale
  24000, // воркшоп launch
  48000, // DFY
  200000, // персональная сборка (нижняя граница)
];

/**
 * 32000 — «late» этап воркшопа: держим в резерве, НЕ анонсируем заранее (§34).
 * 280000 / 380000 / 1500000 — органическая лестница high-ticket, только после
 * диагностики живым человеком, бот их сам не называет как оффер.
 */
export const RESERVE_PRICES_RUB: readonly number[] = [32000, 280000, 380000, 1500000];

export const TARIFFS: Record<TariffId, Tariff> = {
  workshop: {
    id: 'workshop',
    name: 'Воркшоп «Человек 2.0»',
    priceRub: 18000,
    priceLabel: '18 000₽ (стартовая цена потока; растёт по мере заполнения)',
    canCloseAutonomously: true,
    requiresFixedScope: false,
    requiresHumanHandoff: false,
  },
  dfy: {
    id: 'dfy',
    name: 'Готовый агент на вашем сервере',
    priceRub: 48000,
    priceLabel: '48 000₽ (разово за агента навсегда; VPS — отдельно, через нас −50%)',
    canCloseAutonomously: true, // но только при requiresFixedScope=true выполненном по факту
    requiresFixedScope: true,
    requiresHumanHandoff: false,
  },
  custom: {
    id: 'custom',
    name: 'Персональная сборка',
    priceRub: 200000,
    priceLabel: 'от 200 000₽ (по заявке + диагностика, не кнопкой)',
    canCloseAutonomously: false,
    requiresFixedScope: false,
    requiresHumanHandoff: true,
  },
  enterprise: {
    id: 'enterprise',
    name: 'Внедрение в бизнес',
    priceRub: null,
    priceLabel: 'от 1 500 000₽ (по диагностике)',
    canCloseAutonomously: false,
    requiresFixedScope: false,
    requiresHumanHandoff: true,
  },
  sreda: {
    id: 'sreda',
    name: 'Среда внедрения ИИ',
    priceRub: 1800,
    priceLabel: '1 800₽/мес (подписка)',
    canCloseAutonomously: true,
    requiresFixedScope: false,
    requiresHumanHandoff: false,
  },
};

/**
 * Чего бот НЕ обещает ни при каких условиях (жёсткие границы из §25).
 * Используется и в промпте, и в guardrails как стоп-фразы по смыслу.
 */
export const NEVER_PROMISE: readonly string[] = [
  'рост выручки / увеличение продаж как гарантию',
  'замену сотрудников',
  '«внедрение во весь бизнес» за 48k',
  'готового агента «под ключ» под конкретный бизнес без зафиксированного scope',
  'результат сверх состава продукта',
  'свои условия возврата (только отсылка к оферте)',
  'цены и скидки, которых нет в актуальном оффере',
  'закрытие 200k+ оплатой без живого человека',
];

/** Контактная точка для передачи живому человеку (high-ticket). */
export const HUMAN_HANDOFF_CONTACT = '@chipmanager';

/** Платёжный маршрут для прямых тарифов. */
export const PAYMENT_METHOD = 'оплата по QR через банк «Точка» (Tochka QR)';
