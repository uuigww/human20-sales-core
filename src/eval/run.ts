/**
 * Eval-раннер. Прогоняет все сценарии через core, судит LLM-судьёй, печатает отчёт и пишет JSON.
 *
 *   npm run eval                 — все сценарии
 *   npm run eval -- base         — только категория base (base|hard|boundary)
 *
 * Нужен доступ к модели (AI_GATEWAY_API_KEY или ключ провайдера). Для оффлайн-проверки логики
 * без сети см. npm run smoke.
 */

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { respond } from '../core/respond.js';
import { createLeadState } from '../core/leadState.js';
import type { ChatMessage } from '../core/llm/provider.js';
import { SCENARIOS, type Scenario } from './scenarios.js';
import { judgeDialogue, type Judgment, type TranscriptTurn } from './judge.js';

const here = dirname(fileURLToPath(import.meta.url));
const reportsDir = join(here, 'reports');

interface ScenarioResult {
  scenario: Scenario;
  turns: TranscriptTurn[];
  judgment: Judgment | null;
  error?: string;
  hadHardViolation: boolean;
}

function actionLabel(a: { type: string; tariff?: string; reason?: string }): string {
  return [a.type, a.tariff, a.reason].filter(Boolean).join(':');
}

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const history: ChatMessage[] = [];
  let state = createLeadState();
  const turns: TranscriptTurn[] = [];
  let hadHardViolation = false;

  for (const userMsg of scenario.userTurns) {
    const result = await respond({ message: userMsg, history, state });
    const hardViolations = result.violations
      .filter((v) => v.severity === 'hard')
      .map((v) => v.detail);
    if (hardViolations.length) hadHardViolation = true;

    turns.push({
      user: userMsg,
      bot: result.reply,
      actions: result.actions.map(actionLabel),
      links: result.links.map((l) => l.id),
      hardViolations,
    });

    history.push({ role: 'user', content: userMsg });
    history.push({ role: 'assistant', content: result.reply });
    state = result.state;
  }

  try {
    const judgment = await judgeDialogue(scenario, turns);
    return { scenario, turns, judgment, hadHardViolation };
  } catch (err) {
    return { scenario, turns, judgment: null, error: (err as Error).message, hadHardViolation };
  }
}

function avg(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function dimsAvg(j: Judgment): number {
  return avg(Object.values(j.dimensions));
}

function passed(r: ScenarioResult): boolean {
  if (!r.judgment) return false;
  return r.judgment.verdict === 'pass' && r.judgment.boundaryPass && !r.hadHardViolation;
}

async function main() {
  const filter = process.argv[2]?.trim();
  const scenarios = filter ? SCENARIOS.filter((s) => s.category === filter) : SCENARIOS;

  console.log(`\n▶ Eval: ${scenarios.length} сценариев${filter ? ` (категория ${filter})` : ''}\n`);

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    process.stdout.write(`  • ${scenario.id} … `);
    const r = await runScenario(scenario);
    results.push(r);
    if (r.error) {
      console.log(`ОШИБКА: ${r.error}`);
    } else {
      const j = r.judgment!;
      console.log(
        `${passed(r) ? '✓ PASS' : '✗ FAIL'}  ` +
          `[границы:${j.boundaryPass ? 'ok' : 'НАРУШ'} score:${dimsAvg(j).toFixed(1)}]`,
      );
    }
  }

  // Итоги
  const total = results.length;
  const passCount = results.filter(passed).length;
  const boundaryFails = results.filter((r) => r.judgment && !r.judgment.boundaryPass).length;
  const hardViol = results.filter((r) => r.hadHardViolation).length;

  console.log('\n── Итоги ──────────────────────────────');
  console.log(`PASS:               ${passCount}/${total}`);
  console.log(`Нарушений границ:   ${boundaryFails}`);
  console.log(`Hard guardrails:    ${hardViol}`);

  // Провалы детально
  const fails = results.filter((r) => !passed(r));
  if (fails.length) {
    console.log('\n── Провалы ────────────────────────────');
    for (const r of fails) {
      console.log(`\n✗ ${r.scenario.id} — ${r.scenario.title}`);
      if (r.error) {
        console.log(`   ошибка: ${r.error}`);
        continue;
      }
      const j = r.judgment!;
      console.log(`   verdict=${j.verdict} boundaryPass=${j.boundaryPass} hardGuardrails=${r.hadHardViolation}`);
      for (const hr of j.hardRuleResults.filter((x) => !x.pass)) {
        console.log(`   ✗ правило: ${hr.rule} — ${hr.note}`);
      }
      console.log(`   ${j.rationale}`);
    }
  }

  // Запись отчёта
  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = join(reportsDir, `report-${stamp}.json`);
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        total,
        passCount,
        boundaryFails,
        hardViol,
        results: results.map((r) => ({
          id: r.scenario.id,
          category: r.scenario.category,
          pass: passed(r),
          error: r.error,
          hadHardViolation: r.hadHardViolation,
          judgment: r.judgment,
          turns: r.turns,
        })),
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`\nОтчёт: ${reportPath}\n`);

  // Код выхода для CI: фейлим, если есть нарушения границ или hard guardrails.
  if (boundaryFails > 0 || hardViol > 0 || passCount < total) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Eval упал:', err);
  process.exitCode = 1;
});
