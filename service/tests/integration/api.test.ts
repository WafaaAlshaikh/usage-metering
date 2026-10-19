import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import type { Config } from '../../src/config';
import { createPlan } from '../helpers/factories';
import { setupTestDb, type TestDb } from '../helpers/test-db';

const ADMIN = 'test-admin-token';
let t: TestDb;
let app: FastifyInstance;

const config: Config = {
  DATABASE_URL: 'unused',
  PORT: 3000,
  DB_POOL_MAX: 10,
  LOG_LEVEL: 'silent',
  ADMIN_TOKEN: ADMIN,
};

beforeAll(async () => {
  t = await setupTestDb();
  app = buildApp({ db: t.db, config });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await t.close();
});

async function newAccount(name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/accounts',
    headers: { 'x-admin-token': ADMIN },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; apiKey: string };
}

const call = (key: string | undefined, method: 'POST', url: string, payload: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: key ? { 'x-api-key': key } : {} });

let seq = 0;
const consume = (key: string | undefined, over: Record<string, unknown> = {}) =>
  call(key, 'POST', '/consume', { userId: 'u1', units: 5, requestId: `r-${++seq}`, ...over });

describe('health and unknown routes', () => {
  it('GET /health works without a key', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('unknown route is a JSON 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });
});

describe('POST /accounts', () => {
  it('requires the admin token when one is configured', async () => {
    const none = await app.inject({ method: 'POST', url: '/accounts', payload: { name: 'X' } });
    const wrong = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: { 'x-admin-token': 'nope' },
      payload: { name: 'X' },
    });
    expect(none.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
  });

  it('returns the raw key once and never the hash', async () => {
    const acc = await newAccount('Acme');
    expect(acc.apiKey).toMatch(/^mk_/);
    const text = JSON.stringify(acc);
    expect(text).not.toContain('apiKeyHash');
  });

  it('validates the body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: { 'x-admin-token': ADMIN },
      payload: { name: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });
});

describe('API key validation', () => {
  it('rejects a missing key and a wrong key with the same 401', async () => {
    const a = await consume(undefined);
    const b = await consume('mk_not-a-real-key');
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json()).toEqual(b.json());
  });

  it('protects /users too', async () => {
    const res = await call(undefined, 'POST', '/users', { externalId: 'u1' });
    expect(res.statusCode).toBe(401);
  });

    it('a key longer than 200 characters is a 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/account', headers: { 'x-api-key': 'x'.repeat(201) } });
    expect(res.statusCode).toBe(401);
  });

  it.each([{ userId: '' }, { requestId: '' }, { userId: 'x'.repeat(256) }])('rejects %j with 400', async (over) => {
    const acc = await newAccount(`BadBody-${JSON.stringify(over).length}-${Math.random()}`);
    await call(acc.apiKey, 'POST', '/users', { externalId: 'u1' });
    const res = await consume(acc.apiKey, over);
    expect(res.statusCode).toBe(400);
  });
});

describe('consume over HTTP', () => {
  it('registers a user, accepts a request, and replays a retry', async () => {
    const acc = await newAccount('Flow');
    const created = await call(acc.apiKey, 'POST', '/users', { externalId: 'u1' });
    expect(created.statusCode).toBe(201);

    const first = await consume(acc.apiKey, { requestId: 'same', units: 10 });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ accepted: true, replayed: false, user: { remaining: 990 } });

    const retry = await consume(acc.apiKey, { requestId: 'same', units: 10 });
    expect(retry.json()).toMatchObject({ accepted: true, replayed: true, user: { remaining: 990 } });
  });

  it('a rejection is a 200 with the reason', async () => {
    const acc = await newAccount('Reject');
    await call(acc.apiKey, 'POST', '/users', { externalId: 'u1' });
    const res = await consume(acc.apiKey, { units: 25 }); // Basic allows 20 per request
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: false, rejection: { scope: 'user', rule: 'max_per_request' } });
  });

  it('the same requestId with other units is a 409', async () => {
    const acc = await newAccount('Conflict');
    await call(acc.apiKey, 'POST', '/users', { externalId: 'u1' });
    await consume(acc.apiKey, { requestId: 'x', units: 5 });
    const res = await consume(acc.apiKey, { requestId: 'x', units: 6 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('idempotency_conflict');
  });

  it.each([0, -3, 1.5, '5', null, 1e15])('rejects units = %j with 400', async (units) => {
    const acc = await newAccount(`Units-${String(units)}`);
    await call(acc.apiKey, 'POST', '/users', { externalId: 'u1' });
    const res = await consume(acc.apiKey, { units });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('rejects malformed JSON with 400', async () => {
    const acc = await newAccount('BadJson');
    const res = await app.inject({
      method: 'POST',
      url: '/consume',
      headers: { 'x-api-key': acc.apiKey, 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('account isolation', () => {
  it("account B cannot consume for account A's user (404, nothing counted)", async () => {
    const a = await newAccount('A');
    const b = await newAccount('B');
    await call(a.apiKey, 'POST', '/users', { externalId: 'only-in-a' });

    const res = await consume(b.apiKey, { userId: 'only-in-a' });
    expect(res.statusCode).toBe(404);

    const used = await t.pool.query('select count(*)::int as n from request_log where account_id = $1', [a.id]);
    expect(used.rows[0].n).toBe(0);
  });

  it("account B cannot assign account A's custom plan to its user", async () => {
    const a = await newAccount('PlanOwner');
    const b = await newAccount('PlanThief');
    const aPlan = await createPlan(t.db, a.id, 'user', { monthlyAllowance: 50, maxUnitsPerRequest: 5 });

    const res = await call(b.apiKey, 'POST', '/users', { externalId: 'u1', planId: aPlan });
    expect(res.statusCode).toBe(404); // same answer as a plan that does not exist

    const own = await call(a.apiKey, 'POST', '/users', { externalId: 'u1', planId: aPlan });
    expect(own.statusCode).toBe(201);
  });

  it('registering the same externalId twice is a 409; a different account may reuse it', async () => {
    const a = await newAccount('Dup1');
    const b = await newAccount('Dup2');
    expect((await call(a.apiKey, 'POST', '/users', { externalId: 'u1' })).statusCode).toBe(201);
    expect((await call(a.apiKey, 'POST', '/users', { externalId: 'u1' })).statusCode).toBe(409);
    expect((await call(b.apiKey, 'POST', '/users', { externalId: 'u1' })).statusCode).toBe(201);
  });
});