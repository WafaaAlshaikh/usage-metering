import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import type { Config } from '../../src/config';
import { consume as consumeService } from '../../src/services/consume';
import { setupTestDb, type TestDb } from '../helpers/test-db';

const ADMIN = 'test-admin-token';
let t: TestDb;
let app: FastifyInstance;

const config: Config = { DATABASE_URL: 'unused', PORT: 3000, DB_POOL_MAX: 10, LOG_LEVEL: 'silent', ADMIN_TOKEN: ADMIN };

beforeAll(async () => {
  t = await setupTestDb();
  app = buildApp({ db: t.db, config });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await t.close();
});

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
const call = (key: string, method: Method, url: string, payload?: object) =>
  app.inject({ method, url, headers: { 'x-api-key': key }, ...(payload ? { payload } : {}) });

async function newAccount(name: string) {
  const res = await app.inject({ method: 'POST', url: '/accounts', headers: { 'x-admin-token': ADMIN }, payload: { name } });
  return res.json() as { id: string; apiKey: string };
}

let seq = 0;
const consume = (key: string, userId: string, units: number, requestId = `h-${++seq}`) =>
  call(key, 'POST', '/consume', { userId, units, requestId });
const addUser = (key: string, externalId: string, planId?: string) =>
  call(key, 'POST', '/users', { externalId, ...(planId ? { planId } : {}) });

async function userPlanId(key: string, name: string): Promise<string> {
  const plans = (await call(key, 'GET', '/plans?kind=user')).json().plans as { id: string; name: string }[];
  return plans.find((p) => p.name === name)!.id;
}

type UsageUser = { userId: string; consumed: number; remaining: number | null; deleted: boolean };
type UsageBody = {
  period: string;
  account: { consumed: number; remaining: number | null; plan: { name: string } };
  users: UsageUser[];
  nextCursor: string | null;
};
const usage = async (key: string, query = ''): Promise<UsageBody> => (await call(key, 'GET', `/usage${query}`)).json();

type HistoryRow = {
  requestId: string;
  userId: string;
  accepted: boolean;
  rejection: { scope: string; rule: string } | null;
  period: string;
  user: { limits: { maxUnitsPerRequest: number | null } };
};
type HistoryBody = { requests: HistoryRow[]; nextCursor: string | null };
const history = async (key: string, query = ''): Promise<HistoryBody> => (await call(key, 'GET', `/history${query}`)).json();

describe('GET /usage', () => {
  it('shows consumed and remaining for the account and for each user', async () => {
    const a = await newAccount('Usage');
    await addUser(a.apiKey, 'u1'); // Basic: 1000 / 20
    await addUser(a.apiKey, 'u2', await userPlanId(a.apiKey, 'Premium')); // 5000 / 200
    await addUser(a.apiKey, 'u3');
    await consume(a.apiKey, 'u1', 10);
    await consume(a.apiKey, 'u2', 50);

    const body = await usage(a.apiKey);
    expect(body.period).toMatch(/^\d{4}-\d{2}$/);
    expect(body.account).toMatchObject({ consumed: 60, remaining: 9_940, plan: { name: 'Starter' } }); // 10,000/month

    const by = Object.fromEntries(body.users.map((u) => [u.userId, u]));
    expect(by.u1).toMatchObject({ consumed: 10, remaining: 990 });
    expect(by.u2).toMatchObject({ consumed: 50, remaining: 4_950 });
    expect(by.u3).toMatchObject({ consumed: 0, remaining: 1_000 }); // no usage row yet: zero, not missing
  });

  it('previous months stay queryable; the current month starts at zero; an empty month is zero, not 404', async () => {
    const a = await newAccount('Past');
    await addUser(a.apiKey, 'u1');
    await consumeService(
      t.db,
      { accountId: a.id, externalUserId: 'u1', requestId: 'old-1', units: 15 },
      new Date('2025-03-10T12:00:00Z'),
    );

    const old = await usage(a.apiKey, '?period=2025-03');
    expect(old.period).toBe('2025-03');
    expect(old.account.consumed).toBe(15);
    expect(old.users[0]).toMatchObject({ userId: 'u1', consumed: 15, remaining: 985 });

    expect((await usage(a.apiKey)).account.consumed).toBe(0);
    const empty = await usage(a.apiKey, '?period=2020-01');
    expect(empty.account).toMatchObject({ consumed: 0, remaining: 10_000 });
  });

  it.each(['2026-13', 'abc', '2026-1', '2026-10-01'])('rejects period=%s with 400', async (period) => {
    const a = await newAccount(`BadPeriod-${period}`);
    const res = await call(a.apiKey, 'GET', `/usage?period=${period}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('paginates users and repeats the account totals on every page', async () => {
    const a = await newAccount('Paging');
    for (const id of ['a', 'b', 'c']) await addUser(a.apiKey, id);
    await consume(a.apiKey, 'c', 7);

    const p1 = await usage(a.apiKey, '?limit=2');
    expect(p1.users.map((u) => u.userId)).toEqual(['a', 'b']);
    expect(p1.nextCursor).toBe('b');
    const p2 = await usage(a.apiKey, `?limit=2&after=${p1.nextCursor}`);
    expect(p2.users.map((u) => u.userId)).toEqual(['c']);
    expect(p2.nextCursor).toBeNull();
    expect(p1.account.consumed).toBe(7);
    expect(p2.account.consumed).toBe(7);
  });

  it('a deleted user with usage is still listed (so users add up to the account); one without is hidden', async () => {
    const a = await newAccount('Deleted');
    for (const id of ['u1', 'u2', 'u3']) await addUser(a.apiKey, id);
    await consume(a.apiKey, 'u1', 10);
    await consume(a.apiKey, 'u2', 5);
    await call(a.apiKey, 'DELETE', '/users/u1');
    await call(a.apiKey, 'DELETE', '/users/u3');

    const body = await usage(a.apiKey);
    expect(body.users.map((u) => [u.userId, u.deleted])).toEqual([
      ['u1', true],
      ['u2', false],
    ]);
    expect(body.users.reduce((sum, u) => sum + u.consumed, 0)).toBe(body.account.consumed);
  });

  it('a plan reduced below usage shows 0 remaining, never negative', async () => {
    const a = await newAccount('Reduced');
    const plan = await call(a.apiKey, 'POST', '/plans', {
      kind: 'user', name: 'Tight', monthlyAllowance: 100, maxUnitsPerRequest: 100,
    });
    const planId = plan.json().id as string;
    await addUser(a.apiKey, 'u1', planId);
    await consume(a.apiKey, 'u1', 60);
    await call(a.apiKey, 'PATCH', `/plans/${planId}`, { monthlyAllowance: 50 });

    expect((await usage(a.apiKey)).users[0]).toMatchObject({ consumed: 60, remaining: 0 });
  });

  it("one account never sees another account's users, and a key is required", async () => {
    const a = await newAccount('UsageA');
    const b = await newAccount('UsageB');
    await addUser(a.apiKey, 'only-a');
    await consume(a.apiKey, 'only-a', 5);

    const seen = await usage(b.apiKey);
    expect(seen.users).toHaveLength(0);
    expect(seen.account.consumed).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/usage' })).statusCode).toBe(401);
  });
});

describe('GET /history', () => {
  it('lists requests newest first with the decision and the limits applied', async () => {
    const a = await newAccount('Hist');
    await addUser(a.apiKey, 'u1');
    await consume(a.apiKey, 'u1', 10, 'r1');
    await consume(a.apiKey, 'u1', 25, 'r2'); // Basic allows 20 per request
    await consume(a.apiKey, 'u1', 5, 'r3');

    const body = await history(a.apiKey);
    expect(body.requests.map((r) => r.requestId)).toEqual(['r3', 'r2', 'r1']);
    expect(body.requests[1]).toMatchObject({
      userId: 'u1',
      accepted: false,
      rejection: { scope: 'user', rule: 'max_per_request' },
      user: { limits: { maxUnitsPerRequest: 20 } },
    });
    expect(body.requests[0]).toMatchObject({ accepted: true, rejection: null });
    expect(body.nextCursor).toBeNull();
  });

  it('cursor pagination returns every request exactly once', async () => {
    const a = await newAccount('HistPaging');
    await addUser(a.apiKey, 'u1');
    for (let i = 1; i <= 5; i++) await consume(a.apiKey, 'u1', 1, `pg-${i}`);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const body: HistoryBody = await history(a.apiKey, `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      seen.push(...body.requests.map((r) => r.requestId));
      cursor = body.nextCursor;
      pages++;
    } while (cursor);

    expect(seen).toEqual(['pg-5', 'pg-4', 'pg-3', 'pg-2', 'pg-1']);
    expect(pages).toBe(3);
  });

  it('filters by user, outcome and month', async () => {
    const a = await newAccount('HistFilter');
    await addUser(a.apiKey, 'u1');
    await addUser(a.apiKey, 'u2');
    await consume(a.apiKey, 'u1', 5, 'f1');
    await consume(a.apiKey, 'u2', 30, 'f2'); // rejected
    await consumeService(
      t.db,
      { accountId: a.id, externalUserId: 'u1', requestId: 'f-old', units: 5 },
      new Date('2025-03-10T12:00:00Z'),
    );

    const ids = async (q: string) => (await history(a.apiKey, q)).requests.map((r) => r.requestId).sort();
    expect(await ids('?userId=u2')).toEqual(['f2']);
    expect(await ids('?accepted=false')).toEqual(['f2']);
    expect(await ids('?accepted=true')).toEqual(['f-old', 'f1']);
    expect(await ids('?period=2025-03')).toEqual(['f-old']);
    expect(await ids('?userId=u1&accepted=true&period=2025-03')).toEqual(['f-old']);
  });

  it('editing a plan does not rewrite history: old decisions keep the limits they were made under', async () => {
    const a = await newAccount('HistEdit');
    const plan = await call(a.apiKey, 'POST', '/plans', {
      kind: 'user', name: 'Edited', monthlyAllowance: 1000, maxUnitsPerRequest: 20,
    });
    const planId = plan.json().id as string;
    await addUser(a.apiKey, 'u1', planId);

    await consume(a.apiKey, 'u1', 30, 'before'); // rejected under max 20
    await call(a.apiKey, 'PATCH', `/plans/${planId}`, { maxUnitsPerRequest: 50 });
    await consume(a.apiKey, 'u1', 30, 'after'); // accepted under max 50

    const [after, before] = (await history(a.apiKey)).requests;
    expect(after).toMatchObject({ requestId: 'after', accepted: true, user: { limits: { maxUnitsPerRequest: 50 } } });
    expect(before).toMatchObject({
      requestId: 'before',
      accepted: false,
      rejection: { scope: 'user', rule: 'max_per_request' },
      user: { limits: { maxUnitsPerRequest: 20 } },
    });
  });

  it('bad input is a 400, an unknown user a 404', async () => {
    const a = await newAccount('HistErrors');
    const status = async (q: string) => (await call(a.apiKey, 'GET', `/history${q}`)).statusCode;
    expect(await status('?cursor=garbage')).toBe(400);
    expect(await status('?accepted=maybe')).toBe(400);
    expect(await status('?limit=0')).toBe(400);
    expect(await status('?period=2026-99')).toBe(400);
    expect(await status('?userId=ghost')).toBe(404);
  });

  it("isolation: another account's history and users are invisible, and a key is required", async () => {
    const a = await newAccount('HistA');
    const b = await newAccount('HistB');
    await addUser(a.apiKey, 'only-a');
    await consume(a.apiKey, 'only-a', 5, 'a-1');

    expect((await history(b.apiKey)).requests).toHaveLength(0);
    expect((await call(b.apiKey, 'GET', '/history?userId=only-a')).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/history' })).statusCode).toBe(401);
  });
});