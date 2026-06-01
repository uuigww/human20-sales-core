/**
 * Оффлайн-смоук без сети: детерминированно проверяет логику движка и guardrails на mock-провайдере.
 * Нужен для верификации без ключей LLM.
 *
 *   npm run smoke
 */

import { extractMoneyMentions, checkGuardrails } from '../core/guardrails.js';
import { applyUpdate, createLeadState } from '../core/leadState.js';
import { computeLeadScore } from '../core/scorecard.js';
import { StaticKnowledgeProvider } from '../core/knowledge/provider.js';
import { respond } from '../core/respond.js';
import { findUnlistedUrls, isAllowedUrl, resolveLinkIds } from '@human20/ssot';
import {
  InMemoryStore,
  converse,
  makeCustomerId,
  linkByContact,
  findByContact,
  mintLinkCode,
  redeemLinkCode,
} from '../core/memory.js';
import { AbuseGuard, DEFAULT_LIMITS } from '../core/abuseGuard.js';
import type { LLMProvider, StructuredRequest } from '../core/llm/provider.js';

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`  ${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failures++;
}
function eqArr(name: string, a: number[], b: number[]) {
  check(`${name} → [${a}] == [${b}]`, JSON.stringify([...a].sort()) === JSON.stringify([...b].sort()));
}

/** Mock-провайдер: отдаёт заранее заданные ответы по очереди. */
class MockProvider implements LLMProvider {
  private queue: unknown[];
  lastReqMessages: number | null = null;
  constructor(responses: unknown[]) {
    this.queue = [...responses];
  }
  async runStructured<T>(req: StructuredRequest<T>): Promise<T> {
    this.lastReqMessages = req.messages.length;
    if (!this.queue.length) throw new Error('mock: очередь пуста');
    return this.queue.shift() as T;
  }
}

const turn = (
  reply: string,
  actions: unknown[] = [],
  stateUpdate: unknown = {},
  links: string[] = [],
) => ({ reply, stateUpdate, actions, links });

async function run() {
  console.log('\n▶ Smoke (offline)\n');

  // --- extractMoneyMentions ---
  console.log('extractMoneyMentions:');
  eqArr('цены с маркерами', extractMoneyMentions('воркшоп 18 000₽, готовый — 48к'), [18000, 48000]);
  eqArr('не-деньги игнор', extractMoneyMentions('8 человек, 30 дней, скидка 50%'), []);
  eqArr('рубли словом', extractMoneyMentions('подписка 1 800 руб/мес'), [1800]);

  // --- checkGuardrails ---
  console.log('\ncheckGuardrails:');
  check('чистый ответ — ok', checkGuardrails('Расскажи, чем занимаешься?', []).ok);
  check(
    'выдуманная цена — hard',
    checkGuardrails('Это будет стоить 99 000₽', []).violations.some(
      (v) => v.code === 'price_hallucination' && v.severity === 'hard',
    ),
  );
  check(
    'оплата dfy — hard',
    !checkGuardrails('Вот ссылка', [{ type: 'give_payment_link', tariff: 'dfy' }] as never).ok,
  );
  check(
    'оплата 200k — hard',
    !checkGuardrails('Реквизиты', [{ type: 'give_payment_link', tariff: 'custom' }] as never).ok,
  );
  check(
    'оплата workshop — ok',
    checkGuardrails('Держи QR', [{ type: 'give_payment_link', tariff: 'workshop' }] as never).ok,
  );
  check(
    '«аренда агента» — hard',
    checkGuardrails('Ты арендуешь агента за 48к', []).violations.some(
      (v) => v.code === 'agent_rental_mislabel',
    ),
  );
  check(
    '«VPS арендуешь» — НЕ флаг',
    !checkGuardrails('VPS арендуешь через нас со скидкой', []).violations.some(
      (v) => v.code === 'agent_rental_mislabel',
    ),
  );
  check(
    'обещание выручки — soft',
    checkGuardrails('У тебя вырастет выручка', []).violations.some(
      (v) => v.code === 'promise_revenue' && v.severity === 'soft',
    ),
  );
  check(
    'отрицание не флагается',
    !checkGuardrails('Работаем без гарантии результата', []).violations.some(
      (v) => v.code === 'promise_result',
    ),
  );

  // --- вайтлист ссылок ---
  console.log('\nссылки (вайтлист):');
  check('наш домен (wildcard) разрешён', isAllowedUrl('human20.app/payment'));
  check('точная t.me разрешена', isAllowedUrl('https://t.me/human20'));
  check('левый домен запрещён', !isAllowedUrl('scam-site.ru/pay'));
  check('левая t.me запрещена', !isAllowedUrl('t.me/levosignup'));
  check(
    'findUnlistedUrls ловит чужой домен',
    findUnlistedUrls('переходи на scam-site.ru и заплати').length === 1,
  );
  check('findUnlistedUrls не трогает наш', findUnlistedUrls('всё на human20.app/payment').length === 0);
  check('не путает число с доменом', findUnlistedUrls('это стоит 18.000 рублей').length === 0);
  const rl = resolveLinkIds(['demo_bot', 'nope']);
  check('resolveLinkIds: известный резолвится', rl.resolved.some((l) => l.id === 'demo_bot'));
  check('resolveLinkIds: неизвестный отброшен', rl.unknown.includes('nope') && rl.resolved.length === 1);
  check(
    'guardrail: левый URL в reply — hard',
    !checkGuardrails('Оплати тут: oplata-scam.ru', []).ok,
  );
  check('guardrail: наш URL в reply — ok', checkGuardrails('Подробнее на human20.app', []).ok);

  // --- applyUpdate ---
  console.log('\napplyUpdate:');
  const s0 = createLeadState();
  const s1 = applyUpdate(s0, { segment: 'solo', readiness: 150, addPains: ['рутина', 'рутина'] });
  check('segment применился', s1.segment === 'solo');
  check('readiness зажат до 100', s1.readiness === 100);
  check('боли дедуп', s1.pains.length === 1);
  check('исходное состояние не мутировано', s0.pains.length === 0 && s0.segment === 'unknown');

  // --- scorecard ---
  console.log('\nscorecard:');
  const sc0 = createLeadState();
  check('scorecard: дефолт interest=1, cold', sc0.scorecard.interest === 1 && sc0.scorecard.hotness === 'cold');
  const sc1 = applyUpdate(sc0, {
    scorecard: { interest: 9, bant: { budget: 'sufficient' }, riskFlags: ['troll'], barriers: ['дорого'] },
  });
  check('scorecard: interest зажат до 5', sc1.scorecard.interest === 5);
  check('scorecard: bant merge (остальное unknown)', sc1.scorecard.bant.budget === 'sufficient' && sc1.scorecard.bant.authority === 'unknown');
  const sc2 = applyUpdate(sc1, { scorecard: { riskFlags: ['time_waster'], barriers: ['нет времени'] } });
  check('scorecard: riskFlags накапливаются', sc2.scorecard.riskFlags.length === 2);
  check('scorecard: barriers заменяются', sc2.scorecard.barriers.length === 1 && sc2.scorecard.barriers[0] === 'нет времени');

  console.log('\ncomputeLeadScore:');
  const hot = applyUpdate(createLeadState(), {
    stage: 'closing',
    contactCaptured: true,
    scorecard: { interest: 5, bant: { budget: 'sufficient', authority: 'decision_maker', urgency: 'high' }, sentiment: 'positive' },
  });
  check('score: горячий > холодного', computeLeadScore(hot) > computeLeadScore(createLeadState()));
  check('score: горячий высокий (>=80)', computeLeadScore(hot) >= 80);
  check('score: троль штрафуется', computeLeadScore(applyUpdate(hot, { scorecard: { riskFlags: ['troll'] } })) < computeLeadScore(hot));

  console.log('\nStaticKnowledgeProvider:');
  const kp = new StaticKnowledgeProvider();
  const ctx = await kp.productContext('сколько стоит воркшоп?');
  check('knowledge: отдаёт продуктовый контекст', ctx.includes('18 000') || ctx.toLowerCase().includes('воркшоп'));

  // --- respond() с mock-провайдером ---
  console.log('\nrespond() (mock):');

  // 1) Чистый ответ
  const clean = new MockProvider([
    turn('Привет! Чем занимаешься и что хочешь от ИИ?', [], { stage: 'discovery', segment: 'solo' }),
  ]);
  const r1 = await respond({ message: 'Привет', provider: clean });
  check('чистый: reply отдан', r1.reply.includes('Чем занимаешься'));
  check('чистый: state.stage=discovery', r1.state.stage === 'discovery');
  check('чистый: turnCount=1', r1.state.turnCount === 1);
  check('чистый: нет hard-нарушений', !r1.violations.some((v) => v.severity === 'hard'));

  // 2) Нелегальное действие → перегенерация → чистый ответ
  const retry = new MockProvider([
    turn('Вот ссылка на оплату', [{ type: 'give_payment_link', tariff: 'dfy' }]),
    turn('Давай сведу тебя с нашим человеком — он зафиксирует состав.', [
      { type: 'handoff_human', reason: 'scope 48k не зафиксирован' },
    ]),
  ]);
  const r2 = await respond({ message: 'Куплю 48к', provider: retry });
  check('ретрай: дошли до чистого ответа', r2.reply.includes('человеком'));
  check(
    'ретрай: нет незаконной оплаты в actions',
    !r2.actions.some((a) => a.type === 'give_payment_link'),
  );

  // 3) Стойкое нарушение (обе попытки плохие) → безопасный фолбэк
  const bad = new MockProvider([
    turn('Это стоит 99 000₽'),
    turn('Точно 99 000₽, бери'),
  ]);
  const r3 = await respond({ message: 'Сколько?', provider: bad });
  check('фолбэк: передача живому', r3.actions.some((a) => a.type === 'handoff_human'));
  check('фолбэк: stage=handoff', r3.state.stage === 'handoff');
  check('фолбэк: без выдуманной цены в reply', extractMoneyMentions(r3.reply).length === 0);

  // 4) Ссылки: валидные id резолвятся в result.links
  const withLinks = new MockProvider([
    turn('Держи демо, потрогай агента', [{ type: 'offer_demo' }], { stage: 'parked' }, ['demo_bot', 'nope']),
  ]);
  const r4 = await respond({ message: 'дорого, подумаю', provider: withLinks });
  check('ссылки: demo_bot резолвлен', r4.links.some((l) => l.id === 'demo_bot'));
  check('ссылки: неизвестный id не попал', !r4.links.some((l) => l.id === 'nope'));

  // 5) Сырой левый URL в reply → guardrail → фолбэк
  const rawUrl = new MockProvider([
    turn('Оплати на levo-pay.ru'),
    turn('Серьёзно, levo-pay.ru'),
  ]);
  const r5 = await respond({ message: 'как оплатить?', provider: rawUrl });
  check('левый URL: ушли в фолбэк-передачу', r5.actions.some((a) => a.type === 'handoff_human'));
  check('левый URL: в reply нет чужой ссылки', findUnlistedUrls(r5.reply).length === 0);

  // --- память по клиенту ---
  console.log('\nпамять по клиенту:');
  const store = new InMemoryStore();
  const mp = new MockProvider([
    turn('Привет! Чем занимаешься?', [], { segment: 'solo', stage: 'discovery', addPains: ['рутина'] }),
    turn('Понял про рутину. Сам соберёшь или готовое?', [], { stage: 'routing' }),
  ]);
  const c1 = await converse({ store, channel: 'tg', userId: 777, message: 'Привет', provider: mp });
  const c2 = await converse({ store, channel: 'tg', userId: 777, message: 'веду блог', provider: mp });
  check('память: стабильный customerId', c1.customerId === makeCustomerId('tg', 777) && c2.customerId === c1.customerId);
  const rec = await store.load(c1.customerId);
  check('память: история накапливается (4 сообщения)', rec?.history.length === 4);
  check('память: помнит боль из прошлого хода', rec?.state.pains.includes('рутина') ?? false);
  check('память: помнит канал в профиле', rec?.profile.channels.includes('tg') ?? false);
  check('память: turnCount растёт между визитами', rec?.state.turnCount === 2);

  console.log('\nкросс-канальная склейка:');
  await linkByContact(store, 'Test@Mail.ru', c1.customerId);
  check('алиас по контакту (регистр игнор)', (await findByContact(store, 'test@mail.ru')) === c1.customerId);
  const code = await mintLinkCode(store, c1.customerId);
  check('код-токен резолвится в клиента', (await redeemLinkCode(store, code)) === c1.customerId);
  check('неизвестный код → null', (await redeemLinkCode(store, 'ZZZZZZ')) === null);

  console.log('\nокно истории (экономия токенов):');
  const mp2 = new MockProvider(Array.from({ length: 6 }, (_, i) => turn('ответ ' + i)));
  const store2 = new InMemoryStore();
  for (let i = 0; i < 5; i++) {
    await converse({ store: store2, channel: 'web', userId: 'u', message: 'msg' + i, provider: mp2, historyWindow: 4 });
  }
  check('окно: модель получила ≤ window+1 сообщений', (mp2.lastReqMessages ?? 99) <= 5);
  const rec2 = await store2.load(makeCustomerId('web', 'u'));
  check('окно: но хранится вся история (10)', rec2?.history.length === 10);

  // --- abuseGuard (инъекция времени, без задержек) ---
  console.log('\nabuseGuard:');
  let clock = 1_700_000_000_000;
  const gnow = () => clock;

  const gLen = new AbuseGuard(DEFAULT_LIMITS, gnow);
  check('guard: длинное сообщение блокируется', gLen.check('c', 'a'.repeat(DEFAULT_LIMITS.maxMessageChars + 1)).reason === 'too_long');

  const gDup = new AbuseGuard({ ...DEFAULT_LIMITS, duplicateStreak: 3, perMinute: 99 }, gnow);
  gDup.check('c', 'привет');
  gDup.check('c', 'привет');
  check('guard: 3-й дубль подряд → блок', gDup.check('c', 'привет').reason === 'duplicate');
  check('guard: другое сообщение проходит', gDup.check('c', 'другое').allow);

  const gRate = new AbuseGuard({ ...DEFAULT_LIMITS, perMinute: 3, duplicateStreak: 99 }, gnow);
  let allowed = 0;
  for (let i = 0; i < 3; i++) if (gRate.check('c', 'm' + i).allow) allowed++;
  check('guard: rate_minute после лимита', allowed === 3 && gRate.check('c', 'm4').reason === 'rate_minute');

  const gBudget = new AbuseGuard({ ...DEFAULT_LIMITS, perMinute: 999, maxRepliesPerDay: 2, duplicateStreak: 99 }, gnow);
  check('guard: бюджет ответ 1', gBudget.check('c', 'a').allow);
  check('guard: бюджет ответ 2', gBudget.check('c', 'b').allow);
  check('guard: бюджет исчерпан', gBudget.check('c', 'd').reason === 'budget');
  clock += 25 * 3600 * 1000; // +25ч → новые сутки
  check('guard: бюджет сбросился назавтра', gBudget.check('c', 'e').allow);

  console.log('\nconverse + guard:');
  const gStore = new InMemoryStore();
  const noCall = new MockProvider([]); // пустая очередь: если LLM вызовут — увидим по lastReqMessages
  const blocked = await converse({
    store: gStore,
    channel: 'tg',
    userId: 'spammer',
    message: 'x'.repeat(50),
    provider: noCall,
    guard: new AbuseGuard({ ...DEFAULT_LIMITS, maxMessageChars: 10 }, gnow),
  });
  check('converse+guard: помечено blocked', blocked.blocked === 'too_long');
  check('converse+guard: LLM НЕ вызывался', noCall.lastReqMessages === null);
  check('converse+guard: отдан canned-ответ', blocked.reply.length > 0);

  const budgetStore = new InMemoryStore();
  const noCall2 = new MockProvider([]);
  const budgetBlocked = await converse({
    store: budgetStore,
    channel: 'tg',
    userId: 'y',
    message: 'привет',
    provider: noCall2,
    guard: new AbuseGuard({ ...DEFAULT_LIMITS, maxRepliesPerDay: 0 }, gnow),
  });
  check('converse+guard: бюджет → передача живому', budgetBlocked.blocked === 'budget' && budgetBlocked.actions.some((a) => a.type === 'handoff_human'));
  check('converse+guard: бюджет → ссылка на менеджера', budgetBlocked.links.some((l) => l.id === 'manager'));

  console.log(`\n${failures === 0 ? '✓ SMOKE PASS' : `✗ SMOKE FAIL (${failures})`}\n`);
  if (failures > 0) process.exitCode = 1;
}

run().catch((err) => {
  console.error('Smoke упал:', err);
  process.exitCode = 1;
});
