/**
 * LLM-as-judge. Оценивает диалог по рубрике senior-closer и проверяет жёсткие правила сценария.
 * Использует judge-модель (может быть дешевле sales-модели).
 */

import { z } from 'zod';
import { defaultProvider } from '../core/llm/gateway.js';
import type { LLMProvider } from '../core/llm/provider.js';
import type { Scenario } from './scenarios.js';

export interface TranscriptTurn {
  user: string;
  bot: string;
  actions: string[];
  links: string[];
  hardViolations: string[];
}

const dim = z.number().min(1).max(5);

export const judgmentSchema = z.object({
  dimensions: z.object({
    discovery: dim, // диагностика до питча
    valueFraming: dim, // продажа разрыва, не функций
    objectionHandling: dim, // принять→изолировать→переосмыслить→продвинуть
    boundaryCompliance: dim, // соблюдение границ
    tone: dim, // спокойная уверенность, бренд-голос
    closingDiscipline: dim, // один CTA, верный следующий шаг
    noHallucination: dim, // без выдуманных цен/состава/гарантий
  }),
  hardRuleResults: z.array(
    z.object({ rule: z.string(), pass: z.boolean(), note: z.string() }),
  ),
  boundaryPass: z.boolean(),
  verdict: z.enum(['pass', 'fail']),
  rationale: z.string(),
});

export type Judgment = z.infer<typeof judgmentSchema>;

const RUBRIC = `Ты — строгий ревизор отдела продаж. Оцениваешь, продаёт ли ИИ-продажник на уровне
сеньора с огромным опытом в нише «внедрение ИИ-агентов». Оцени диалог по шкале 1–5 по каждому измерению:
- discovery: сначала диагностика, потом питч; точные вопросы, понимание боли и её цены.
- valueFraming: продаёт результат и стоимость бездействия, а не список функций.
- objectionHandling: возражения как сигналы; принять→переосмыслить→продвинуть, без спора и давления.
- boundaryCompliance: не переобещает, не выдумывает цены/гарантии, верно разводит тарифы, вовремя
  передаёт живому; 48k не называет «арендой».
- tone: спокойная уверенность, тепло, бренд-голос «Человек 2.0», без инфобиз-пафоса.
- closingDiscipline: один мягкий CTA за реплику, верный следующий шаг (не всегда самый дорогой тариф).
- noHallucination: ноль выдуманных фактов/цен/условий возврата.

Затем проверь каждое hard-правило сценария: pass=true только если бот реально его соблюл.
boundaryPass=false, если нарушено хотя бы одно hard-правило ИЛИ были hardViolations от guardrails.
verdict='pass' только если boundaryPass=true И все измерения >= 3 И ключевые (boundaryCompliance,
noHallucination) >= 4. Будь строг, но справедлив. rationale — кратко по-русски.`;

function renderTranscript(scenario: Scenario, turns: TranscriptTurn[]): string {
  const lines = turns.map((t, i) => {
    const parts = [
      `[ход ${i + 1}]`,
      `Клиент: ${t.user}`,
      `Продажник: ${t.bot}`,
      `Действия: ${t.actions.length ? t.actions.join(', ') : '—'}`,
      `Ссылки: ${t.links.length ? t.links.join(', ') : '—'}`,
    ];
    if (t.hardViolations.length) parts.push(`⚠ guardrails: ${t.hardViolations.join('; ')}`);
    return parts.join('\n');
  });
  return [
    `Сценарий: ${scenario.title} (категория ${scenario.category})`,
    `Фокус: ${scenario.rubricFocus}`,
    'Hard-правила для проверки:',
    ...scenario.hardRules.map((r, i) => `  ${i + 1}. ${r}`),
    '',
    'Диалог:',
    ...lines,
  ].join('\n');
}

export async function judgeDialogue(
  scenario: Scenario,
  turns: TranscriptTurn[],
  provider: LLMProvider = defaultProvider,
): Promise<Judgment> {
  return provider.runStructured<Judgment>({
    system: RUBRIC,
    messages: [{ role: 'user', content: renderTranscript(scenario, turns) }],
    schema: judgmentSchema,
    schemaName: 'judgment',
    schemaDescription: 'Оценка диалога продажника по рубрике + проверка hard-правил',
    role: 'judge',
    temperature: 0,
  });
}
