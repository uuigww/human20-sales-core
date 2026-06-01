/**
 * Guardrails — детерминированная пост-проверка ответа против SSOT и границ.
 * Это страховка от срывов, НЕ замена качества промпта. Тонкие нарушения (тон, переобещание
 * по смыслу) ловит LLM-судья в eval; здесь — жёсткие, однозначно проверяемые вещи.
 *
 *  hard-нарушение → respond() перегенерирует ответ с поправкой; если не помогло — безопасный фолбэк.
 *  soft-нарушение → логируется/учитывается судьёй, но не ломает ход.
 */

import { VALID_PRICES_RUB, RESERVE_PRICES_RUB, findUnlistedUrls } from '@human20/ssot';
import { AUTONOMOUS_PAYMENT_TARIFFS, type Action } from './actions.js';

export type Severity = 'hard' | 'soft';

export interface Violation {
  severity: Severity;
  code: string;
  detail: string;
}

export interface GuardrailResult {
  ok: boolean; // нет hard-нарушений
  violations: Violation[];
}

const ALLOWED_PRICES = new Set<number>([...VALID_PRICES_RUB, ...RESERVE_PRICES_RUB]);

/**
 * Достаёт денежные суммы (в рублях), упомянутые в тексте, ТОЛЬКО когда есть явный денежный
 * маркер (₽/руб) или сокращение тысяч (к/тыс). Так «8 человек», «30 дней», «50%» не считаются ценой.
 */
export function extractMoneyMentions(text: string): number[] {
  const found: number[] = [];

  // 1) Суммы с символом/словом валюты: "18 000₽", "1 800 руб", "48000 р."
  const currencyRe = /(\d[\d\s ]*\d|\d)\s*(?:₽|руб(?:\.|лей|ля)?|р\.)/gi;
  for (const m of text.matchAll(currencyRe)) {
    const n = Number(m[1]!.replace(/[\s ]/g, ''));
    if (Number.isFinite(n) && n > 0) found.push(n);
  }

  // 2) Сокращение тысяч: "48к", "200 тыс", "1.5 тыс". Лукахед отсекает «5 кг», «48 квартир».
  const kRe = /(\d+(?:[.,]\d+)?)\s*(?:к|тыс\.?|тысяч)(?![а-яёa-z])/gi;
  for (const m of text.matchAll(kRe)) {
    const n = Math.round(Number(m[1]!.replace(',', '.')) * 1000);
    if (Number.isFinite(n) && n > 0) found.push(n);
  }

  return found;
}

// Внимание: \w/\b в JS-regex только ASCII и НЕ матчат кириллицу — используем [а-яё].
const AGENT_RENTAL_RE =
  /(?:аренд[а-яё]*\s+(?:агент|бот)|(?:агент|бот)[а-яё]*\s+(?:в\s+|на\s+)?аренд)/i;

interface PromisePattern {
  re: RegExp;
  code: string;
  detail: string;
}

const FORBIDDEN_PROMISES: PromisePattern[] = [
  { re: /вырас[а-яё]*\s+(?:выручк|продаж|доход)/i, code: 'promise_revenue', detail: 'обещание роста выручки/продаж' },
  { re: /увелич[а-яё]*\s+(?:выручк|продаж|доход)/i, code: 'promise_revenue', detail: 'обещание увеличения выручки/продаж' },
  { re: /замен[а-яё]*\s+сотрудник/i, code: 'promise_replace_staff', detail: 'обещание замены сотрудников' },
  { re: /гаранти[а-яё]*\s+результат/i, code: 'promise_result', detail: 'гарантия результата' },
];

/** Есть ли отрицание (не/без/нет) непосредственно перед позицией match. \b не годится для кириллицы. */
function negatedBefore(text: string, index: number): boolean {
  const window = text.slice(Math.max(0, index - 20), index).toLowerCase();
  return /(?:^|[^а-яё])(?:не|без|нет)\s+(?:[а-яё]+\s+)?$/.test(window);
}

export function checkGuardrails(reply: string, actions: Action[]): GuardrailResult {
  const violations: Violation[] = [];

  // 1) Галлюцинация цены: любая денежная сумма должна быть из известного набора.
  for (const amount of extractMoneyMentions(reply)) {
    if (!ALLOWED_PRICES.has(amount)) {
      violations.push({
        severity: 'hard',
        code: 'price_hallucination',
        detail: `упомянута неизвестная цена ${amount}₽ (нет в оффере)`,
      });
    }
  }

  // 2) Нелегальное действие оплаты: give_payment_link только для workshop/sreda.
  for (const a of actions) {
    if (a.type === 'give_payment_link') {
      const tariff = a.tariff;
      if (!tariff || !AUTONOMOUS_PAYMENT_TARIFFS.includes(tariff)) {
        violations.push({
          severity: 'hard',
          code: 'illegal_payment_action',
          detail: `give_payment_link для «${tariff ?? 'без тарифа'}» запрещён — 48k/200k+ закрывает живой человек`,
        });
      }
    }
  }

  // 3) «Левые» ссылки: любой URL вне реестра links.ts — hard. Ссылки даём только через поле links.
  for (const url of findUnlistedUrls(reply)) {
    violations.push({
      severity: 'hard',
      code: 'unlisted_link',
      detail: `ссылка вне вайтлиста: ${url} (давать ссылки только по id из реестра)`,
    });
  }

  // 4) Подмена 48k «арендой агента/бота».
  if (AGENT_RENTAL_RE.test(reply)) {
    violations.push({
      severity: 'hard',
      code: 'agent_rental_mislabel',
      detail: 'агент 48k назван «арендой» — он остаётся у клиента навсегда (аренда только у VPS)',
    });
  }

  // 5) Переобещания (soft — narrow, с учётом отрицания).
  for (const p of FORBIDDEN_PROMISES) {
    const m = p.re.exec(reply);
    if (m && !negatedBefore(reply, m.index)) {
      violations.push({ severity: 'soft', code: p.code, detail: p.detail });
    }
  }

  return { ok: !violations.some((v) => v.severity === 'hard'), violations };
}

/** Подсказка для перегенерации: что именно нарушено. */
export function correctionNote(violations: Violation[]): string {
  const hard = violations.filter((v) => v.severity === 'hard');
  return (
    'Твой предыдущий ответ нарушил границы и был отклонён. Исправь и не повторяй:\n' +
    hard.map((v) => `- ${v.detail}`).join('\n') +
    '\nНе называй цен, которых нет в оффере. Не давай ссылку на оплату для 48k/200k+ — для них ' +
    'квалифицируй и передавай живому человеку. 48k — это покупка агента навсегда, не аренда. ' +
    'НЕ пиши сырые URL в тексте — чтобы дать ссылку, добавь её id в поле links (только из реестра).'
  );
}
