#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AGENTS, RANGES, buildSnapshot, jumpHandle } from './aggregate.js';
import { orcaSwitch } from './proc.js';

const HOST = '127.0.0.1';
const INDEX_HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'index.html');
const MAX_BODY = 16 * 1024;

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      port: { type: 'string', default: '4777' },
      json: { type: 'boolean', default: false },
      range: { type: 'string', default: 'today' },
      agent: { type: 'string', default: 'all' },
    },
  }));
} catch (e) {
  console.error(e.message);
  console.error('使い方: node src/server.js [--port 4777] [--json] [--range today|24h|7d|30d|all] [--agent all|claude|agy]');
  process.exit(1);
}

const port = Number(args.port);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`不正なポート番号: ${args.port}`);
  process.exit(1);
}

const pickRange = (v) => (RANGES.includes(v) ? v : 'today');
const pickAgent = (v) => (AGENTS.includes(v) ? v : 'all');

if (args.json) {
  // head などでパイプが閉じられても異常終了させない
  process.stdout.on('error', (e) => {
    if (e.code === 'EPIPE') process.exit(0);
    throw e;
  });
  const snap = await buildSnapshot({ range: pickRange(args.range), agent: pickAgent(args.agent) });
  process.stdout.write(`${JSON.stringify(snap, null, 2)}\n`);
} else {
  startServer();
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('リクエストが大きすぎます'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function startServer() {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  const server = http.createServer(async (req, res) => {
    try {
      // DNS リバインディング対策として Host ヘッダも確認する
      if (!allowedHosts.has(req.headers.host ?? '')) return send(res, 403, { ok: false, error: 'forbidden host' });
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        let html;
        try {
          html = fs.readFileSync(INDEX_HTML, 'utf8');
        } catch {
          return send(res, 404, 'public/index.html がありません', 'text/plain; charset=utf-8');
        }
        return send(res, 200, html, 'text/html; charset=utf-8');
      }

      if (req.method === 'GET' && url.pathname === '/api/snapshot') {
        const snap = await buildSnapshot({
          range: pickRange(url.searchParams.get('range')),
          agent: pickAgent(url.searchParams.get('agent')),
        });
        return send(res, 200, snap);
      }

      if (url.pathname === '/api/jump') {
        if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' });
        const origin = req.headers.origin;
        if (origin !== undefined && !allowedOrigins.has(origin)) {
          return send(res, 403, { ok: false, error: 'forbidden origin' });
        }
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return send(res, 400, { ok: false, error: 'JSON を解釈できません' });
        }
        const { agent, id } = body ?? {};
        if (!['claude', 'agy'].includes(agent) || typeof id !== 'string' || !id) {
          return send(res, 400, { ok: false, error: 'agent と id を指定してください' });
        }
        const handle = await jumpHandle(agent, id);
        if (!handle) return send(res, 404, { ok: false, error: 'ジャンプ先の端末が見つかりません' });
        try {
          await orcaSwitch(handle);
        } catch (e) {
          return send(res, 500, { ok: false, error: `端末の切り替えに失敗: ${e.message}` });
        }
        return send(res, 200, { ok: true });
      }

      return send(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      console.error(e);
      if (!res.headersSent) send(res, 500, { ok: false, error: String(e?.message ?? e) });
    }
  });

  server.on('error', (e) => {
    const msg =
      e.code === 'EADDRINUSE'
        ? `ポート ${port} は使用中です(--port で別のポートを指定してください)`
        : `サーバーを起動できません: ${e.message}`;
    console.error(msg);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    console.log(`ai-agent-monitor: http://${HOST}:${port}/`);
  });
}
