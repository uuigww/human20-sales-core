# Развёртывание AI-продажника на сервере

Инструкция для установки на сервер: поднять API, подключить Postgres (память лидов) и проверить,
что всё работает. Два пути: **A — Docker (проще)** и **B — вручную**.

---

## Что нужно заранее
- Сервер с Linux (любой VPS). Для пути A — установленные **Docker** и **Docker Compose**.
- **Ключ OpenAI** (`OPENAI_API_KEY`). Это единственный обязательный секрет для работы продажника.
- Доступ к репозиторию `github.com/uuigww/human20-sales-core` (приватный).

---

## Путь A — Docker Compose (рекомендуется)

Поднимает API **и** Postgres(pgvector) одной командой. Схема БД применяется автоматически.

```bash
git clone git@github.com:uuigww/human20-sales-core.git
cd human20-sales-core

cp .env.example .env
# открой .env и заполни как минимум:
#   OPENAI_API_KEY=sk-...        (ключ OpenAI)
#   API_KEY=придумай-длинный-секрет   (защита API — ОБЯЗАТЕЛЬНО)
# DATABASE_URL в .env можно НЕ трогать — compose подставит внутренний адрес БД сам.

docker compose up -d --build
```

Проверка:
```bash
curl http://localhost:8080/health
# {"ok":true,"info":"store=postgres · knowledge=static · model=openai/gpt-5-mini"}
```

Логи: `docker compose logs -f app`. Остановить: `docker compose down` (данные БД сохранятся в томе).

> Память клиентов уже работает — она в Postgres (том `pgdata`). RAG по умолчанию выключен
> (знания берутся из встроенного SSOT). Как включить RAG — см. ниже.

---

## Путь B — вручную (Node + свой Postgres)

Нужен Node.js 20+ и свой Postgres с расширением `pgvector`.

```bash
git clone git@github.com:uuigww/human20-sales-core.git
cd human20-sales-core
npm ci

cp .env.example .env
# заполни в .env:
#   OPENAI_API_KEY=sk-...
#   API_KEY=длинный-секрет
#   DATABASE_URL=postgres://user:pass@host:5432/dbname

# применить схему БД (таблицы лидов + knowledge_chunks):
psql "$DATABASE_URL" -f db/schema.sql

npm start
```

Без `DATABASE_URL` сервер тоже запустится, но память будет в файлах (`./data`) — это режим для теста,
не для прода.

---

## API

Все запросы (кроме `/health`) требуют заголовок `x-api-key: <API_KEY>`.

### POST /message — основной эндпоинт
```bash
curl -X POST http://localhost:8080/message \
  -H "content-type: application/json" \
  -H "x-api-key: ВАШ_API_KEY" \
  -d '{"channel":"tg","userId":12345,"message":"Привет, что у вас есть?"}'
```
Ответ:
```json
{
  "reply": "Привет! Расскажи, чем занимаешься...",
  "links": [ { "id": "demo_bot", "title": "Демо-агент", "url": "https://t.me/...", "ready": true } ],
  "actions": [ { "type": "offer_demo" } ],
  "blocked": null,
  "customerId": "tg:12345"
}
```

Как использует адаптер канала (TG/VK/сайт):
- `channel` — имя канала (`tg`/`vk`/`max`/`web`), `userId` — id пользователя в этом канале.
- Показать `reply`. Для каждой ссылки из `links` — отправить (текст/кнопка). Исполнить `actions`
  (оплата/CRM/передача живому). `customerId` идентифицирует клиента (память ведётся по нему).
- Если `blocked` не null — сработал анти-спам, `reply` уже содержит мягкую заготовку.

### GET /leads/hot — горячие лиды (только при Postgres)
```bash
curl "http://localhost:8080/leads/hot?minScore=60&limit=50" -H "x-api-key: ВАШ_API_KEY"
```
Возвращает лиды, отсортированные по `lead_score` (0–100): сегмент, интерес, горячесть, контакт.

### GET /health — проверка живости (без ключа).

---

## Включить RAG (знания по всему проекту)
По умолчанию продажник знает оффер из встроенного SSOT. Чтобы подключить базу знаний по проекту
(семантический поиск по документам):

1. Добавить документы в `packages/ssot/src/manifest.ts` (`KNOWLEDGE_SOURCES`).
2. Проиндексировать в pgvector:
   ```bash
   # путь A: docker compose exec app npm run ingest
   # путь B: npm run ingest
   ```
3. В `.env` выставить `USE_RAG=true` и перезапустить (`docker compose up -d` или `npm start`).

Границы (что НЕ обещать, цены) всегда берутся из кода, не из RAG — это защита от ошибок.

---

## Безопасность (важно)
- **Обязательно задай `API_KEY`** — иначе API открыт всем (на `/health` это видно по предупреждению в логах).
- Ключи только в `.env` на сервере (он в `.gitignore`), никогда в git/чат.
- Для боевого домена поставь reverse-proxy (nginx/Caddy) с HTTPS перед сервисом и ограничь `ALLOW_ORIGIN`
  доменом сайта (напр. `https://human20.app`).
- Анти-спам (rate-limit + дневной бюджет на клиента) включён по умолчанию — защищает от слива токенов.

---

## Модель
По умолчанию `openai/gpt-5-mini` (дёшево, ~1–4₽ за диалог). Сменить — переменной `SALES_MODEL` в `.env`
(см. варианты там). Не-OpenAI модели требуют `AI_GATEWAY_API_KEY` вместо `OPENAI_API_KEY`.

## Диагностика
- `GET /health` показывает активную конфигурацию (`store`/`knowledge`/`model`).
- Логи: `docker compose logs -f app` (путь A) или вывод `npm start` (путь B).
- `401 unauthorized` → не передан/неверный `x-api-key`.
- `/leads/hot` отвечает 400 «нужна Postgres-память» → не задан `DATABASE_URL`.
