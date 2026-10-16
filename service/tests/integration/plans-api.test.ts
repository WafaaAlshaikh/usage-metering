import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import type { Config } from '../../src/config';
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

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const call = (key: string, method: Method, url: string, payload?: object) =>
  app.inject({ method, url, headers: { 'x-api-key': key }, ...(payload ? { payload } : {}) });

async function newAccount(name: string) {
  const res = await app.inject({ method: 'POST', url: '/accounts', headers: { 'x-admin-token': ADMIN }, payload: { name } });
  return res.json() as { id: string; apiKey: string };
}

let seq = 0;
const consume = (key: string, userId: string, units: number) =>
  call(key, 'POST', '/consume', { userId, units, requestId: `p-${++seq}` });

async function newPlan(key: string, over: Record<string, unknown> = {}) {
  const res = await call(key, 'POST', '/plans', {
    kind: 'user',
    name: `plan-${++seq}`,
    monthlyAllowance: 100,
    maxUnitsPerRequest: 20,
    ...over,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

describe('listing and creating plans', () => {
  it('lists the four predefined plans and filters by kind', async () => {
    const a = await newAccount('List');
    const all = (await call(a.apiKey, 'GET', '/plans')).json().plans as { name: string; isPredefined: boolean }[];
    expect(all.map((p) => p.name).sort()).toEqual(['Basic', 'Premium', 'Pro', 'Starter']);
    const users = (await call(a.apiKey, 'GET', '/plans?kind=user')).json().plans as { name: string }[];
    expect(users.map((p) => p.name).sort()).toEqual(['Basic', 'Premium']);
  });

  it('creates a custom plan, visible only to its owner', async () => {
    const a = await newAccount('Owner');
    const b = await newAccount('Other');
    const plan = await newPlan(a.apiKey, { name: 'Gold', monthlyAllowance: null });
    const mine = await call(a.apiKey, 'GET', `/plans/${plan.id}`);
    expect(mine.json()).toMatchObject({ name: 'Gold', monthlyAllowance: null, maxUnitsPerRequest: 20, isPredefined: false });
    expect((await call(b.apiKey, 'GET', `/plans/${plan.id}`)).statusCode).toBe(404);
    const theirList = (await call(b.apiKey, 'GET', '/plans')).json().plans as { id: string }[];
    expect(theirList.some((p) => p.id === plan.id)).toBe(false);
  });

  it('rejects invalid limits and duplicate names', async () => {
    const a = await newAccount('Validate');
    for (const bad of [{ maxUnitsPerRequest: 0 }, { monthlyAllowance: -1 }, { monthlyAllowance: 1.5 }, { kind: 'team' }]) {
      const res = await call(a.apiKey, 'POST', '/plans', { kind: 'user', name: 'x', ...bad });
      expect(res.statusCode).toBe(400);
    }
    await newPlan(a.apiKey, { name: 'Same' });
    const dup = await call(a.apiKey, 'POST', '/plans', { kind: 'user', name: 'Same' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('plan_name_taken');
  });
});

describe('changing plans', () => {
  it('predefined plans are read-only; another account plan is a 404', async () => {
    const a = await newAccount('RO');
    const b = await newAccount('RO2');
    const basic = ((await call(a.apiKey, 'GET', '/plans?kind=user')).json().plans as { id: string; name: string }[]).find(
      (p) => p.name === 'Basic',
    )!;
    const patch = await call(a.apiKey, 'PATCH', `/plans/${basic.id}`, { monthlyAllowance: 1 });
    expect(patch.statusCode).toBe(403);
    expect(patch.json().error.code).toBe('plan_read_only');
    expect((await call(a.apiKey, 'DELETE', `/plans/${basic.id}`)).statusCode).toBe(403);

    const mine = await newPlan(a.apiKey);
    expect((await call(b.apiKey, 'PATCH', `/plans/${mine.id}`, { monthlyAllowance: 1 })).statusCode).toBe(404);
    expect((await call(b.apiKey, 'DELETE', `/plans/${mine.id}`)).statusCode).toBe(404);
  });

  it('an edit applies to the next request, with no client change', async () => {
    const a = await newAccount('Edit');
    const plan = await newPlan(a.apiKey, { maxUnitsPerRequest: 20 });
    await call(a.apiKey, 'POST', '/users', { externalId: 'u1', planId: plan.id });

    const before = await consume(a.apiKey, 'u1', 30);
    expect(before.json()).toMatchObject({ accepted: false, rejection: { scope: 'user', rule: 'max_per_request' } });

    const patched = await call(a.apiKey, 'PATCH', `/plans/${plan.id}`, { maxUnitsPerRequest: 50 });
    expect(patched.statusCode).toBe(200);

    const after = await consume(a.apiKey, 'u1', 30);
    expect(after.json()).toMatchObject({ accepted: true, user: { remaining: 70 } });
  });

  it('PATCH with null removes a limit; an empty PATCH is a 400', async () => {
    const a = await newAccount('Null');
    const plan = await newPlan(a.apiKey);
    const res = await call(a.apiKey, 'PATCH', `/plans/${plan.id}`, { monthlyAllowance: null });
    expect(res.json().monthlyAllowance).toBeNull();
    expect((await call(a.apiKey, 'PATCH', `/plans/${plan.id}`, {})).statusCode).toBe(400);
  });
});

describe('assigning plans', () => {
  it('switching a user keeps its usage and shows the new plan', async () => {
    const a = await newAccount('Switch');
    await call(a.apiKey, 'POST', '/users', { externalId: 'u1' }); // Basic: 1000 / 20
    await consume(a.apiKey, 'u1', 10);
    const gold = await newPlan(a.apiKey, { monthlyAllowance: 500, maxUnitsPerRequest: 100 });

    const res = await call(a.apiKey, 'PUT', '/users/u1/plan', { planId: gold.id });
    expect(res.statusCode).toBe(200);
    expect(res.json().plan.id).toBe(gold.id);

    const r = await consume(a.apiKey, 'u1', 50);
    expect(r.json()).toMatchObject({ accepted: true, user: { remaining: 440 } }); // 500 - 10 - 50
    expect((await call(a.apiKey, 'GET', '/users/u1')).json().plan.id).toBe(gold.id);
  });

  it('refuses another account plan or a plan of the wrong kind (404)', async () => {
    const a = await newAccount('AssignA');
    const b = await newAccount('AssignB');
    await call(b.apiKey, 'POST', '/users', { externalId: 'u1' });
    const aPlan = await newPlan(a.apiKey);
    const accountKind = await newPlan(b.apiKey, { kind: 'account' });
    expect((await call(b.apiKey, 'PUT', '/users/u1/plan', { planId: aPlan.id })).statusCode).toBe(404);
    expect((await call(b.apiKey, 'PUT', '/users/u1/plan', { planId: accountKind.id })).statusCode).toBe(404);
  });

  it('an account plan change applies to every user of the account', async () => {
    const a = await newAccount('AccountPlan');
    await call(a.apiKey, 'POST', '/users', { externalId: 'u1' });
    const tiny = await newPlan(a.apiKey, { kind: 'account', monthlyAllowance: 5, maxUnitsPerRequest: null });

    expect((await consume(a.apiKey, 'u1', 10)).json().accepted).toBe(true); // Starter allows it
    const res = await call(a.apiKey, 'PUT', '/account/plan', { planId: tiny.id });
    expect(res.statusCode).toBe(200);
    expect((await call(a.apiKey, 'GET', '/account')).json().plan.id).toBe(tiny.id);

    // 10 units were already used, so the new 5/month allowance leaves 0 and rejects.
    const r = await consume(a.apiKey, 'u1', 1);
    expect(r.json()).toMatchObject({
      accepted: false,
      rejection: { scope: 'account', rule: 'monthly_allowance' },
      account: { remaining: 0 },
    });
  });

  it('a user plan cannot be assigned to the account', async () => {
    const a = await newAccount('WrongKind');
    const userPlan = await newPlan(a.apiKey);
    expect((await call(a.apiKey, 'PUT', '/account/plan', { planId: userPlan.id })).statusCode).toBe(404);
  });

    it('users sharing one plan keep separate usage, and a plan edit reaches both', async () => {
    const a = await newAccount('Shared');
    const shared = await newPlan(a.apiKey, { monthlyAllowance: 100, maxUnitsPerRequest: 100 });
    await call(a.apiKey, 'POST', '/users', { externalId: 'u1', planId: shared.id });
    await call(a.apiKey, 'POST', '/users', { externalId: 'u2', planId: shared.id });

    expect((await consume(a.apiKey, 'u1', 80)).json()).toMatchObject({ accepted: true, user: { remaining: 20 } });
    // u2 has the same plan definition but its own 100 units
    expect((await consume(a.apiKey, 'u2', 80)).json()).toMatchObject({ accepted: true, user: { remaining: 20 } });
    // u1 cannot borrow u2's allowance
    expect((await consume(a.apiKey, 'u1', 30)).json()).toMatchObject({
      accepted: false,
      rejection: { scope: 'user', rule: 'monthly_allowance' },
    });

    await call(a.apiKey, 'PATCH', `/plans/${shared.id}`, { monthlyAllowance: 200 });
    expect((await consume(a.apiKey, 'u2', 30)).json()).toMatchObject({ accepted: true, user: { remaining: 90 } }); // 200 - 80 - 30
  });
  
});

describe('archiving', () => {
  it('current users keep working; nobody new can get the plan', async () => {
    const a = await newAccount('Archive');
    const plan = await newPlan(a.apiKey);
    await call(a.apiKey, 'POST', '/users', { externalId: 'u1', planId: plan.id });
    await call(a.apiKey, 'POST', '/users', { externalId: 'u3' });

    const del = await call(a.apiKey, 'DELETE', `/plans/${plan.id}`);
    expect(del.statusCode).toBe(200);
    expect(del.json().archived).toBe(true);
    expect((await call(a.apiKey, 'DELETE', `/plans/${plan.id}`)).statusCode).toBe(200); // safe to repeat

    expect((await consume(a.apiKey, 'u1', 5)).json().accepted).toBe(true);

    const newUser = await call(a.apiKey, 'POST', '/users', { externalId: 'u2', planId: plan.id });
    expect(newUser.statusCode).toBe(409);
    expect(newUser.json().error.code).toBe('plan_archived');
    expect((await call(a.apiKey, 'PUT', '/users/u3/plan', { planId: plan.id })).statusCode).toBe(409);
    expect((await call(a.apiKey, 'PUT', '/users/u1/plan', { planId: plan.id })).statusCode).toBe(200);

    const hidden = (await call(a.apiKey, 'GET', '/plans?kind=user')).json().plans as { id: string }[];
    expect(hidden.some((p) => p.id === plan.id)).toBe(false);
    const shown = (await call(a.apiKey, 'GET', '/plans?includeArchived=true')).json().plans as { id: string }[];
    expect(shown.some((p) => p.id === plan.id)).toBe(true);
  });
});

describe('users: list, inspect, delete', () => {
  it('lists users with their plans and paginates', async () => {
    const a = await newAccount('Paging');
    for (const id of ['a', 'b', 'c']) await call(a.apiKey, 'POST', '/users', { externalId: id });
    const p1 = (await call(a.apiKey, 'GET', '/users?limit=2')).json();
    expect(p1.users.map((u: { userId: string }) => u.userId)).toEqual(['a', 'b']);
    expect(p1.users[0].plan.name).toBe('Basic');
    const p2 = (await call(a.apiKey, 'GET', `/users?limit=2&after=${p1.nextCursor}`)).json();
    expect(p2.users.map((u: { userId: string }) => u.userId)).toEqual(['c']);
    expect(p2.nextCursor).toBeNull();
  });

  it('delete is soft: 410 afterwards, gone from the list, re-register keeps usage', async () => {
    const a = await newAccount('Soft');
    await call(a.apiKey, 'POST', '/users', { externalId: 'u1' });
    await consume(a.apiKey, 'u1', 10);

    expect((await call(a.apiKey, 'DELETE', '/users/u1')).statusCode).toBe(204);
    expect((await call(a.apiKey, 'DELETE', '/users/u1')).statusCode).toBe(204);
    expect((await call(a.apiKey, 'GET', '/users/u1')).statusCode).toBe(410);
    expect((await consume(a.apiKey, 'u1', 1)).statusCode).toBe(410);
    expect((await call(a.apiKey, 'GET', '/users')).json().users).toHaveLength(0);

    const back = await call(a.apiKey, 'POST', '/users', { externalId: 'u1' });
    expect(back.json().reactivated).toBe(true);
    expect((await consume(a.apiKey, 'u1', 1)).json().user.remaining).toBe(989); // 1000 - 10 - 1
  });

  it("another account cannot see or delete this account's user", async () => {
    const a = await newAccount('Priv1');
    const b = await newAccount('Priv2');
    await call(a.apiKey, 'POST', '/users', { externalId: 'secret' });
    expect((await call(b.apiKey, 'GET', '/users/secret')).statusCode).toBe(404);
    expect((await call(b.apiKey, 'DELETE', '/users/secret')).statusCode).toBe(404);
    expect((await call(b.apiKey, 'GET', '/users')).json().users).toHaveLength(0);
  });
});

describe('auth', () => {
  it('every new route needs an API key', async () => {
    for (const [method, url] of [
      ['GET', '/plans'],
      ['GET', '/account'],
      ['GET', '/users'],
      ['DELETE', '/users/x'],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(401);
    }
  });
});