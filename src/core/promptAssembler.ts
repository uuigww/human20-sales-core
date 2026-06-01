/**
 * Сборщик system prompt. Собирает «мозг» из слоёв:
 *   персона + бренд-голос + знания продукта (через KnowledgeProvider) + ВСЕГДА границы (статикой) +
 *   playbook + скрипт + возражения + маршрутизация + эталоны + ссылки + стадия + сводка лида + контракт.
 *
 * Продуктовый нарратив (offer) приходит готовой строкой `productContext` (статика или RAG).
 * Границы (boundaries) инжектятся ВСЕГДА из @human20/ssot — они safety-critical и не зависят от RAG.
 * Playbook (поведение) живёт в core, всегда целиком.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LeadState } from './leadState.js';
import { summarizeState } from './leadState.js';
import { stageGuidance } from './stageMachine.js';
import { HUMAN_HANDOFF_CONTACT, PAYMENT_METHOD, linkCatalog, loadBoundaries } from '@human20/ssot';

const here = dirname(fileURLToPath(import.meta.url));
const playbookDir = join(here, '..', 'playbook');

function read(path: string): string {
  return readFileSync(path, 'utf8').trim();
}

function readExemplars(): string {
  const dir = join(playbookDir, 'exemplars');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => read(join(dir, f)))
    .join('\n\n---\n\n');
}

/** Статичные слои поведения (playbook) и границы — читаются один раз. */
const BRAIN = {
  persona: read(join(playbookDir, 'persona.md')),
  voice: read(join(playbookDir, 'voice.md')),
  boundaries: loadBoundaries(),
  methodology: read(join(playbookDir, 'methodology.md')),
  script: read(join(playbookDir, 'script.md')),
  objections: read(join(playbookDir, 'objections.md')),
  routing: read(join(playbookDir, 'routing.md')),
  exemplars: readExemplars(),
};

const OUTPUT_CONTRACT = `# Формат ответа (строго)

Ты возвращаешь структуру:
- reply — твоя реплика клиенту (живой текст, как в эталонах; обычно 1–5 предложений; один мягкий CTA максимум).
- stateUpdate — что ты понял в этом ходу: сегмент, стадия, интерес-тариф, готовность (0–100),
  захвачен ли контакт, новые боли/возражения/заметки, и scorecard (оцени по фактам диалога, не выдумывай):
  interest (1–5), hotness (cold/warm/hot), bant (budget/authority/urgency/timeline), sentiment,
  riskFlags, barriers, nextBestAction, dealPotential (tariff + ожидаемая сумма ₽), intentSummary (1 строка).
  Меняй только то, что реально прояснилось в этом ходу.
- actions — что должен сделать канал. Доступные действия и правила:
  - give_payment_link (tariff) — ТОЛЬКО для workshop или sreda. Для dfy/custom/enterprise НЕЛЬЗЯ.
  - offer_demo — когда уместно дать потрогать демо-агента.
  - add_to_waitlist — записать в лист ожидания.
  - capture_lead — когда появился контакт/сегмент, который стоит сохранить в базу.
  - collect_200k_brief (tariff=custom) — когда ведёшь анкету под персональную сборку.
  - handoff_human (reason) — передать живому (${HUMAN_HANDOFF_CONTACT}): для 200k+/enterprise,
    для 48k без зафиксированного scope, для юр./нестандартных вопросов, по просьбе клиента.
  Действий может быть 0, 1 или несколько. Если действие не нужно — пустой массив.
- links — массив id ссылок из «ДОСТУПНЫЕ ССЫЛКИ», которые нужно показать в этом ходу. [] если не нужно.

# ССЫЛКИ — СТРОГОЕ ПРАВИЛО
НИКОГДА не пиши URL/домены/«http…»/«t.me/…» прямо в reply и не выдумывай адреса. Любая ссылка
передаётся ТОЛЬКО через поле links по её id из списка ниже. В тексте можешь сослаться словами
(«держи демо», «вот оферта»), а сам адрес подставит система. Если подходящей ссылки в списке нет —
не давай никакой. Платёжные ссылки/QR не выдаёшь сам: для оплаты используй action give_payment_link.

Платёжный маршрут для прямых тарифов: ${PAYMENT_METHOD}.`;

/** Собирает полный system prompt под текущий ход. productContext — оффер (статика или RAG). */
export function assembleSystemPrompt(state: LeadState, productContext: string): string {
  return [
    '# ТЫ',
    BRAIN.persona,
    '\n# БРЕНД-ГОЛОС',
    BRAIN.voice,
    '\n# ЗНАНИЯ О ПРОДУКТЕ (SSOT — не противоречь и не выдумывай сверх этого)',
    productContext,
    '\n# ЖЁСТКИЕ ГРАНИЦЫ (важнее любой продажи)',
    BRAIN.boundaries,
    '\n# МЕТОДОЛОГИЯ',
    BRAIN.methodology,
    '\n# СКРИПТ ПРОДАЖ (спина диалога — следуй гибко, не дословно)',
    BRAIN.script,
    '\n# ВОЗРАЖЕНИЯ',
    BRAIN.objections,
    '\n# МАРШРУТИЗАЦИЯ',
    BRAIN.routing,
    '\n# ЭТАЛОННЫЕ ДИАЛОГИ (как звучит сеньор — ориентируйся на стиль и логику, не копируй дословно)',
    BRAIN.exemplars,
    '\n# ДОСТУПНЫЕ ССЫЛКИ (давать только эти, строго по id через поле links)',
    linkCatalog(),
    '\n# ТЕКУЩАЯ СТАДИЯ',
    stageGuidance(state.stage),
    '\n# ЧТО ИЗВЕСТНО О СОБЕСЕДНИКЕ (память диалога)',
    summarizeState(state),
    '\n' + OUTPUT_CONTRACT,
  ].join('\n');
}
