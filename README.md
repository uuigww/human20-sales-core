# Core AI-продажник «Человек 2.0»

Канало-независимый **мозг продаж**: один core, который подключают к сайту и ботам
(Telegram, MAX, VK, чат). Адаптеры каналов — тонкие: доставляют сообщения и исполняют действия,
вся логика продаж, память клиентов и скоринг — здесь.

> Продаёт как **сеньор с огромным опытом**: диагностика до питча, продажа разрыва, отработка
> возражений как сигналов, дисциплина закрытия и жёсткие границы (не переобещает, не выдумывает цены,
> не даёт левых ссылок, вовремя передаёт живому).

## Архитектура

```
packages/ssot  (@human20/ssot)        ← SSOT продукта: факты + манифест для RAG
   offer.ts (типы/цены) · offer.md · boundaries.md · links.ts · manifest.ts
        ▲ потребляют оба
   ┌────┴───────────────────┐
 core (этот пакет)        серверный RAG (pgvector)
   guardrails ← типы из @human20/ssot (АВТОРИТЕТ цен/ссылок)
   promptAssembler ← KnowledgeProvider (Static | RAG); границы — ВСЕГДА статикой
   converse() ← MemoryStore (InMemory/JsonFile dev | Postgres прод) + AbuseGuard
```

Принцип: **знания (факты) отделены от поведения (playbook).** Факты можно вынести в RAG; поведение и
валидация остаются в коде. Типизированный `offer.ts`/`links.ts` — источник правды для guardrails,
его нельзя завязывать на нечёткий RAG.

## Структура

```
packages/ssot/src/   offer.ts · offer.md · boundaries.md · links.ts · manifest.ts · index   (@human20/ssot)
src/
  knowledge/   provider.ts (Static/Rag KnowledgeProvider) · pgVectorRetriever.ts
  playbook/    persona · voice · methodology · script · objections · routing · exemplars/
  core/        respond · promptAssembler · leadState · scorecard · stageMachine · actions ·
               guardrails · memory · abuseGuard · stores/postgresStore · llm/
  eval/        scenarios · judge · run · smoke
  cli.ts · index.ts
scripts/       ingest-knowledge.ts   (RAG-индексация в pgvector)
db/            schema.sql            (leads + lead_aliases + knowledge_chunks)
config/        models.ts
```

## Установка

```bash
npm install                 # ставит и core, и workspace-пакет @human20/ssot
cp .env.example .env        # вписать OPENAI_API_KEY (см. ниже)
```

`.env` (достаточно ключа OpenAI; Postgres/gateway — для прода):
```
OPENAI_API_KEY=sk-...       # ⚠️ только сюда, не в чат/код
# DATABASE_URL=postgres://...   # для прод-памяти и RAG
# AI_GATEWAY_API_KEY=...        # если нужен не-OpenAI провайдер
```

## Команды

| Команда | Что делает | Нужен ключ/БД |
|---|---|---|
| `npm run smoke` | Оффлайн-проверка движка/guardrails/памяти/скоринга (mock) | нет |
| `npm run typecheck` | Проверка типов по всем пакетам | нет |
| `npm run chat` | REPL — поговорить с продажником | OPENAI_API_KEY |
| `npm run eval` | 19 сценариев через LLM-судью + отчёт | OPENAI_API_KEY |
| `npm run ingest` | Индексация SSOT в pgvector для RAG | DATABASE_URL + OPENAI_API_KEY |

## Модель (без Claude — он дорогой; цены ≈ за 1M токенов)
| Роль | Модель | Цена | Почему |
|---|---|---|---|
| **Основная (дефолт)** | `openai/gpt-5-mini` | ~$0.25 / $2.00 | Дёшево + строго держит границы + сильный русский. |
| Альтернатива | `google/gemini-2.5-flash` | ~$0.30 / $2.50 | Огромный контекст. По результату eval. |
| Ультра-бюджет | `deepseek/deepseek-v4` | ~$0.14 in | Дёшево; **обязательно прогнать eval** (тон/границы слабее). |

Меняется в `.env` (`SALES_MODEL`) или `config/models.ts`. **Методика:** бери самую дешёвую модель,
которая проходит `npm run eval` на 100% по границам — guardrails страхуют даже дешёвую модель.

## Контракт для адаптера канала

Один вызов `converse()` — он сам помнит клиента (грузит/сохраняет), скорит, режет спам:

```ts
import { converse, JsonFileStore, AbuseGuard } from 'human20-sales-core/src/index.js';

const store = new JsonFileStore('./data/customers');  // dev; прод — PostgresStore (ниже)
const guard = new AbuseGuard();

const r = await converse({
  store, channel: 'tg', userId: msg.from.id, message: msg.text, guard,
  // knowledge: ragProvider,   // прод: RAG (ниже). dev: дефолт — статика из @human20/ssot
});

if (r.blocked) { /* спам зарезан до LLM; r.reply — мягкая заготовка */ }
await channel.send(r.reply);
for (const l of r.links) await channel.sendLink(l.title, l.url);   // только из вайтлиста
for (const a of r.actions) await execute(a);                       // оплата/CRM/передача
```

Низкоуровневый примитив — `respond({ message, history, state, knowledge, provider })`.

## Память по клиентам (и между ботами)
- **id клиента:** `makeCustomerId(channel, nativeId)` → `"tg:12345"`. Хранится состояние + история +
  профиль + **scorecard**.
- **Хранилище:** интерфейс `MemoryStore`. `InMemoryStore`/`JsonFileStore` (dev), `PostgresStore` (прод).
- **Склейка между каналами:** `linkByContact(store,email,id)`/`findByContact`; код-токен
  `mintLinkCode`→`redeemLinkCode`→`mergeFrom`.

## Скоринг лида (scorecard)
Модель ведёт карточку каждый ход (оценивает по фактам), код считает числовой `leadScore` 0–100:
- `interest` 1–5 · `hotness` cold/warm/hot · `sentiment` + `riskFlags` (troll/time_waster)
- **BANT:** budget · authority · urgency · timeline
- `barriers` (что мешает) · `nextBestAction` (рекомендация менеджеру)
- `dealPotential` (ожидаемый тариф + сумма ₽) · `intentSummary` (1 строка)

`computeLeadScore(state)` (0–100) денормализуется в колонку `lead_score` Postgres — горячие лиды
выбираются SQL:
```sql
SELECT customer_id, segment, interest, hotness, lead_score, contact
FROM leads WHERE lead_score >= 60 ORDER BY lead_score DESC LIMIT 50;
```

## Знания продукта (SSOT) и RAG
- **SSOT** живёт в пакете `@human20/ssot` (`offer`, `boundaries`, `links` + `manifest.ts`). Меняешь
  продукт — правишь здесь, расходится и в core, и в RAG.
- **dev (по умолчанию):** `StaticKnowledgeProvider` вшивает весь оффер в промпт.
- **прод (RAG):** подключаешь все документы проекта на сервере. Шаги:
  1. `psql "$DATABASE_URL" -f db/schema.sql` — таблицы (вкл. `knowledge_chunks` с pgvector).
  2. Добавить документы в `packages/ssot/src/manifest.ts` (`KNOWLEDGE_SOURCES`).
  3. `npm run ingest` — чанкует, считает эмбеддинги (text-embedding-3-small, 1536), пишет в pgvector.
  4. Подключить `RagKnowledgeProvider(createPgVectorRetriever(pool, embed))` в `converse({ knowledge })`.
- **Границы (`boundaries.md`) всегда инжектятся статикой**, не через RAG — это safety-critical.

### Прод-обвязка (Postgres + RAG + guard)
```ts
import { Pool } from 'pg';
import { createOpenAI } from '@ai-sdk/openai';
import { embed } from 'ai';
import {
  converse, PostgresStore, AbuseGuard,
  RagKnowledgeProvider, createPgVectorRetriever,
} from 'human20-sales-core/src/index.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
const embedFn = async (t: string) =>
  (await embed({ model: openai.embedding('text-embedding-3-small'), value: t })).embedding;

const store = new PostgresStore(pool);
const knowledge = new RagKnowledgeProvider(createPgVectorRetriever(pool, embedFn));
const guard = new AbuseGuard();

const r = await converse({ store, channel: 'tg', userId, message, guard, knowledge });
```

## Ссылки — строгий вайтлист
Все ссылки — в `packages/ssot/src/links.ts`. Модель не пишет URL в текст, а кладёт **id** в поле
`links`; движок резолвит из реестра; guardrail режет любой URL вне реестра. Заполни `ready:false`
(demo_bot, oferta, waitlist, vk) реальными адресами. Платёжки — не сюда (динамический QR через action
`give_payment_link`).

## Анти-спам (защита токенов)
`AbuseGuard` проверяет сообщение **до** LLM (заблокированное = 0 токенов): длина → дубли → rate
(мин/час/день) → дневной бюджет ответов. Дефолт: 20/мин · 100/час · 300/день · 40 ответов/сутки ·
≤2000 симв · 3 дубля. Настройка: `new AbuseGuard({ perMinute: 15 })`. Прод-счётчики → вынести в Redis.

## Оптимизация стоимости (включено)
Prompt caching (статика первой в промпте) · `maxOutputTokens` · окно истории (`historyWindow=12`) ·
сменная модель. Ориентир: ~1–4₽ за диалог.

## Границы (жёстко, `boundaries.md`)
18k/Среда — до оплаты сам · 48k — только квалификация + передача живому (scope фиксирует человек) ·
200k+/enterprise — заявка + живой · не обещает выручку/замену сотрудников/«всё за 48k» · гарантии —
только оферта · 48k ≠ «аренда».

## Что dev vs прод
| | dev | прод |
|---|---|---|
| Память | `JsonFileStore` | `PostgresStore` |
| Знания | `StaticKnowledgeProvider` | `RagKnowledgeProvider` (pgvector) |
| Анти-спам счётчики | in-memory | Redis (по интерфейсу) |
| Модель | `openai/gpt-5-mini` | она же / по eval |

## Вне scope
Реальные адаптеры каналов (TG/VK/MAX/чат) и платёжка Tochka QR — поверх `converse()`. Тонкий RAG
(реранкинг, гибридный поиск) — после базового pgvector.
```
