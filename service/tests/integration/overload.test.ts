import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import type { Config } from '../../src/config';
import { createDb } from '../../src/db/client';
import { TEST_DATABASE_URL, setupTestDb, type TestDb } from '../helpers/test-db';

const ADMIN = 'test-admin-token';
const config: Config = { DATABASE_URL: 'unused', PORT: 3000, DB_POOL_MAX: 1, LOG_LEVEL: 'silent', ADMIN_TOKEN: ADMIN };

let t: TestDb; 
let tiny: ReturnType<typeof createDb>; 
let app: FastifyInstance;
let key: string;

beforeAll(async () => {
  t = await setupTestDb();
  const setup = buildApp({ db: t.db, config });
  await setup.ready();
  const acc = (
    await setup.inject({ method: 'POST', url: '/accounts', headers: { 'x-admin-token': ADMIN }, payload: { name: 'Busy' } })
  ).json() as { apiKey: string };
  key = acc.apiKey;
  await setup.inject({ method: 'POST', url: '/users', headers: { 'x-api-key': key }, payload: { externalId: 'u1' } });
  await setup.close();

  tiny = createDb(TEST_DATABASE_URL, { max: 1, connectionTimeoutMs: 200 });
  app = buildApp({ db: tiny.db, config });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await tiny.pool.end();
  await t.close();
});

describe('overload', () => {
  it('answers 503 with Retry-After when no database connection is available, and recovers', async () => {
        const held = await tiny.pool.connect(); 
    let res;
    try {
      res = await app.inject({
        method: 'POST',
        url: '/consume',
        headers: { 'x-api-key': key },
        payload: { userId: 'u1', units: 1, requestId: 'busy-1' },
      });
    } finally {
      held.release();
    }
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.json().error.code).toBe('busy');

    const ok = await app.inject({
      method: 'POST',
      url: '/consume',
      headers: { 'x-api-key': key },
      payload: { userId: 'u1', units: 1, requestId: 'busy-1' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ accepted: true, replayed: false });
  });
});