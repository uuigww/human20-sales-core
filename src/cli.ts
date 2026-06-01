/**
 * Локальный REPL — «поговорить с продажником» для ручного смоук-теста.
 *
 *   npm run chat
 *
 * Нужен доступ к модели (AI_GATEWAY_API_KEY или ключ провайдера) и SALES_MODEL.
 * Команды: /reset — новый диалог, /state — показать состояние лида, /exit — выход.
 */

import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { respond } from './core/respond.js';
import { createLeadState, summarizeState, type LeadState } from './core/leadState.js';
import type { ChatMessage } from './core/llm/provider.js';
import { models } from '../config/models.js';

async function main() {
  const rl = createInterface({ input: stdin, output: stdout });
  let history: ChatMessage[] = [];
  let state: LeadState = createLeadState();

  console.log('\n🧠 Продажник «Человек 2.0». Модель:', models.sales);
  console.log('Команды: /reset, /state, /exit\n');

  while (true) {
    const msg = (await rl.question('Ты: ')).trim();
    if (!msg) continue;
    if (msg === '/exit') break;
    if (msg === '/reset') {
      history = [];
      state = createLeadState();
      console.log('— новый диалог —\n');
      continue;
    }
    if (msg === '/state') {
      console.log('\n' + summarizeState(state) + '\n');
      continue;
    }

    const result = await respond({ message: msg, history, state });
    console.log('\nПродажник:', result.reply);
    if (result.actions.length) {
      console.log(
        '  ⚙ действия:',
        result.actions.map((a) => [a.type, a.tariff, a.reason].filter(Boolean).join(':')).join(', '),
      );
    }
    if (result.links.length) {
      console.log('  🔗 ссылки:', result.links.map((l) => `${l.title} → ${l.url}`).join(' | '));
    }
    if (result.violations.length) {
      console.log('  ⚠ guardrails:', result.violations.map((v) => `${v.severity}:${v.code}`).join(', '));
    }
    console.log();

    history.push({ role: 'user', content: msg });
    history.push({ role: 'assistant', content: result.reply });
    state = result.state;
  }

  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
