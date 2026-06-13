/**
 * HTTP API продажника. Минимальный сервер на node:http (без доп. зависимостей).
 *
 *   npm start
 *
 * Эндпоинты:
 *   GET  /health                       → { ok, info }
 *   POST /message  {channel,userId,message} → { reply, links, actions, blocked, customerId }
 *   GET  /leads/hot?minScore=&limit=   → { leads } (только при Postgres-памяти)
 *
 * Авторизация: заголовок  x-api-key: <API_KEY>  (если API_KEY задан в env).
 * CORS: Access-Control-Allow-Origin = ALLOW_ORIGIN (по умолчанию *).
 */

import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { converse } from '../index.js';
import { PostgresStore } from '../core/stores/postgresStore.js';
import { buildServices } from './bootstrap.js';

const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.API_KEY?.trim();
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const MAX_BODY = 64 * 1024; // 64 КБ — защита от гигантских тел

const svc = buildServices();

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': ALLOW_ORIGIN,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-api-key',
  });
  res.end(json);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');

    if (req.method === 'OPTIONS') return send(res, 204, undefined);

    // health — без авторизации
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true, info: svc.info });
    }

    // авторизация для остальных
    if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
      return send(res, 401, { error: 'unauthorized' });
    }

    if (req.method === 'POST' && url.pathname === '/message') {
      const body = (await readJson(req).catch(() => null)) as
        | { channel?: unknown; userId?: unknown; message?: unknown }
        | null;
      if (!body || !body.channel || body.userId == null || !body.message) {
        return send(res, 400, { error: 'нужны поля: channel, userId, message' });
      }
      const r = await converse({
        store: svc.store,
        guard: svc.guard,
        injectionGuard: svc.injectionGuard,
        knowledge: svc.knowledge,
        channel: String(body.channel),
        userId: body.userId as string | number,
        message: String(body.message),
      });
      return send(res, 200, {
        reply: r.reply,
        links: r.links,
        actions: r.actions,
        blocked: r.blocked ?? null,
        customerId: r.customerId,
      });
    }

    if (req.method === 'GET' && url.pathname === '/leads/hot') {
      if (!(svc.store instanceof PostgresStore)) {
        return send(res, 400, { error: 'нужна Postgres-память (задайте DATABASE_URL)' });
      }
      const minScore = Number(url.searchParams.get('minScore') || 60);
      const limit = Number(url.searchParams.get('limit') || 50);
      const leads = await svc.store.listHotLeads(minScore, limit);
      return send(res, 200, { leads });
    }

    send(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('API error:', err);
    send(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, () => {
  const auth = API_KEY ? 'API_KEY задан' : '⚠️ API_KEY НЕ задан (эндпоинты открыты!)';
  console.log(`Sales API на :${PORT} · ${svc.info} · ${auth}`);
});
