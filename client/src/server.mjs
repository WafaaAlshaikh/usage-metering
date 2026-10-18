import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as demo from './demo.mjs';

const PORT = Number(process.env.PORT ?? 4000);
const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/index.html');

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 100_000) throw new demo.ServiceError(413, null, 'Body too large');
    chunks.push(c);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new demo.ServiceError(400, null, 'Invalid JSON');
  }
}

const server = createServer(async (req, res) => {
  try {
    const p = new URL(req.url ?? '/', 'http://x').pathname;
    const m = req.method;
    let match;

    if (m === 'GET' && (p === '/' || p === '/index.html')) return send(res, 200, await readFile(INDEX), 'text/html; charset=utf-8');
    if (m === 'GET' && p === '/health') return send(res, 200, { status: 'ok' });
    if (m === 'GET' && p === '/api/state') return send(res, 200, await demo.getState());

    if (m === 'POST' && p === '/api/reset') {
      await demo.seed();
      return send(res, 200, await demo.getState());
    }
    if (m === 'POST' && p === '/api/consume') {
      const b = await readJson(req);
      return send(res, 200, await demo.consume(b.userId, b.units));
    }
    if (m === 'POST' && (match = p.match(/^\/api\/scenario\/([a-z-]+)$/))) {
      return send(res, 200, await demo.scenario(match[1]));
    }
    if (m === 'PUT' && (match = p.match(/^\/api\/users\/([^/]+)\/plan$/))) {
      const b = await readJson(req);
      return send(res, 200, await demo.switchUserPlan(decodeURIComponent(match[1]), b.planId));
    }
    if (m === 'PATCH' && (match = p.match(/^\/api\/plans\/([0-9a-f-]{36})$/))) {
      return send(res, 200, await demo.updatePlan(match[1], await readJson(req)));
    }
    if (m === 'POST' && p === '/api/proxy') {
      return send(res, 200, await demo.proxy(await readJson(req)));
    }
    return send(res, 404, { error: { code: 'not_found', message: 'Not found' } });
  } catch (err) {
    if (err instanceof demo.ServiceError) return send(res, err.status, err.body);
    console.error(err);
    return send(res, 500, { error: { code: 'internal_error', message: 'Internal error' } });
  }
});

await demo.seed(); // first start: create the demo account before accepting visitors
server.listen(PORT, '0.0.0.0', () => console.log(`demo client on http://localhost:${PORT}`));