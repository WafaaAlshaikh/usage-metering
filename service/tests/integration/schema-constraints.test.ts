import type { PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { plans, SYSTEM_OWNER_KEY } from '../../src/db/schema';
import { seedPredefinedPlans } from '../../src/db/seed';
import { attempt, setupTestDb, type TestDb } from '../helpers/test-db';

let t: TestDb;
let c: PoolClient;

beforeAll(async () => {
  t = await setupTestDb();
});
afterAll(async () => {
  await t.close();
});

// Every test runs in a transaction that is rolled back, so tests never see each other's rows.
beforeEach(async () => {
  c = await t.pool.connect();
  await c.query('begin');
});
afterEach(async () => {
  await c.query('rollback');
  c.release();
});

const one = async (text: string, params: unknown[] = []) => (await c.query(text, params)).rows[0];
const planId = async (name: string) => (await one('select id from plans where name = $1 and is_predefined', [name])).id as string;

let keySeq = 0;
async function makeAccount(name: string): Promise<string> {
  const starter = await planId('Starter');
  return (
    await one(
      `insert into accounts(name, api_key_hash, api_key_prefix, account_plan_id, account_plan_owner_key)
       values ($1, $2, 'k', $3, $4) returning id`,
      [name, `hash-${name}-${keySeq++}`, starter, SYSTEM_OWNER_KEY],
    )
  ).id;
}

async function makeCustomPlan(accountId: string, kind: 'account' | 'user', name: string): Promise<string> {
  return (
    await one(
      `insert into plans(account_id, kind, name, monthly_allowance, max_units_per_request)
       values ($1, $2, $3, 500, 50) returning id`,
      [accountId, kind, name],
    )
  ).id;
}

async function makeUser(accountId: string, externalId: string, planIdValue?: string, ownerKey?: string): Promise<string> {
  return (
    await one(
      `insert into users(account_id, external_id, user_plan_id, user_plan_owner_key)
       values ($1, $2, $3, $4) returning id`,
      [accountId, externalId, planIdValue ?? (await planId('Basic')), ownerKey ?? SYSTEM_OWNER_KEY],
    )
  ).id;
}

const insertUsage = (userId: string, accountId: string) =>
  attempt(c, `insert into user_usage(user_id, account_id, period_start, consumed) values ($1, $2, '2026-10-01', 1)`, [userId, accountId]);

const insertLog = async (userId: string, accountId: string, over: { accountPlan?: string; accountPlanKind?: string } = {}) =>
  attempt(
    c,
    `insert into request_log(account_id, user_id, request_id, units, accepted, period_start,
                             account_plan_id, account_plan_kind, user_plan_id)
     values ($1, $2, $3, 5, true, '2026-10-01', $4, $5, $6)`,
    [accountId, userId, `req-${keySeq++}`, over.accountPlan ?? (await planId('Starter')), over.accountPlanKind ?? 'account', await planId('Basic')],
  );

describe('plan ownership and isolation', () => {
  it('rejects a user-kind plan as an account plan', async () => {
    const a = await makeAccount('A');
    await expect(
      attempt(c, `update accounts set account_plan_id = $1 where id = $2`, [await planId('Basic'), a]),
    ).rejects.toMatchObject({ constraint: 'accounts_plan_fk' });
  });

  it("rejects another account's custom plan on an account, whatever owner key is claimed", async () => {
    const a = await makeAccount('A');
    const b = await makeAccount('B');
    const aPlan = await makeCustomPlan(a, 'account', 'A-Enterprise');
    // claiming B as the owner: the plan's real owner is A, so the composite FK fails
    await expect(
      attempt(c, `update accounts set account_plan_id = $1, account_plan_owner_key = $2 where id = $3`, [aPlan, b, b]),
    ).rejects.toMatchObject({ constraint: 'accounts_plan_fk' });
    // claiming A as the owner: matches the plan, but A is not "me or system"
    await expect(
      attempt(c, `update accounts set account_plan_id = $1, account_plan_owner_key = $2 where id = $3`, [aPlan, a, b]),
    ).rejects.toMatchObject({ constraint: 'accounts_plan_owner_is_self_or_system' });
  });

  it('lets an account use its own custom plan', async () => {
    const a = await makeAccount('A');
    const aPlan = await makeCustomPlan(a, 'account', 'A-Enterprise');
    await attempt(c, `update accounts set account_plan_id = $1, account_plan_owner_key = $2 where id = $3`, [aPlan, a, a]);
  });

  it("rejects another account's custom plan on a user, whatever owner key is claimed", async () => {
    const a = await makeAccount('A');
    const b = await makeAccount('B');
    const aPlan = await makeCustomPlan(a, 'user', 'A-Gold');
    const insertUser = (owner: string) =>
      attempt(c, `insert into users(account_id, external_id, user_plan_id, user_plan_owner_key) values ($1, 'user-123', $2, $3)`, [b, aPlan, owner]);
    await expect(insertUser(b)).rejects.toMatchObject({ constraint: 'users_plan_fk' });
    await expect(insertUser(a)).rejects.toMatchObject({ constraint: 'users_plan_owner_is_own_account_or_system' });
    await expect(insertUser(SYSTEM_OWNER_KEY)).rejects.toMatchObject({ constraint: 'users_plan_fk' });
  });

  it('accepts a predefined plan or the own account custom plan on a user', async () => {
    const a = await makeAccount('A');
    await makeUser(a, 'u-predefined');
    await makeUser(a, 'u-custom', await makeCustomPlan(a, 'user', 'A-Gold'), a);
  });

  it('rejects an account-kind plan on a user', async () => {
    const a = await makeAccount('A');
    await expect(makeUser(a, 'u1', await planId('Starter'))).rejects.toMatchObject({ constraint: 'users_plan_fk' });
  });

  it('does not allow the reserved system key as an account id', async () => {
    await expect(
      attempt(c, `insert into accounts(id, name, api_key_hash, api_key_prefix, account_plan_id, account_plan_owner_key)
                  values ($1, 'evil', 'h-evil', 'k', $2, $1)`, [SYSTEM_OWNER_KEY, await planId('Starter')]),
    ).rejects.toMatchObject({ constraint: 'accounts_id_not_system_owner' });
  });
});

describe('user and account always belong together', () => {
  it('rejects usage rows pairing a user with another account', async () => {
    const a = await makeAccount('A');
    const b = await makeAccount('B');
    const userOfB = await makeUser(b, 'user-123');
    await expect(insertUsage(userOfB, a)).rejects.toMatchObject({ constraint: 'user_usage_user_account_fk' });
    await insertUsage(userOfB, b);
  });

  it('rejects request-log rows pairing a user with another account', async () => {
    const a = await makeAccount('A');
    const b = await makeAccount('B');
    const userOfB = await makeUser(b, 'user-123');
    await expect(insertLog(userOfB, a)).rejects.toMatchObject({ constraint: 'request_log_user_account_fk' });
    await insertLog(userOfB, b);
  });
});

describe('request_log plan kinds', () => {
  it('rejects a user-kind plan as the account plan', async () => {
    const a = await makeAccount('A');
    const u = await makeUser(a, 'u1');
    const basic = await planId('Basic');
    await expect(insertLog(u, a, { accountPlan: basic })).rejects.toMatchObject({ constraint: 'request_log_account_plan_fk' });
    await expect(insertLog(u, a, { accountPlan: basic, accountPlanKind: 'user' })).rejects.toMatchObject({
      constraint: 'request_log_account_plan_kind_is_account',
    });
  });
});

describe('archiving and soft delete', () => {
  it('never allows archiving a predefined plan', async () => {
    await expect(attempt(c, `update plans set archived_at = now() where name = 'Starter'`)).rejects.toMatchObject({
      constraint: 'plans_predefined_not_archived',
    });
  });

  it('archiving a custom plan keeps it assigned to users who already have it', async () => {
    const a = await makeAccount('A');
    const gold = await makeCustomPlan(a, 'user', 'A-Gold');
    const u = await makeUser(a, 'u1', gold, a);
    await attempt(c, `update plans set archived_at = now() where id = $1`, [gold]);
    expect((await one('select user_plan_id from users where id = $1', [u])).user_plan_id).toBe(gold);
  });

  it('soft-deleting a user keeps its usage, and the external id stays taken (re-activate, never duplicate)', async () => {
    const a = await makeAccount('A');
    const u = await makeUser(a, 'u1');
    await insertUsage(u, a);
    await attempt(c, `update users set deleted_at = now() where id = $1`, [u]);
    expect((await one('select consumed from user_usage where user_id = $1', [u])).consumed).toBe('1');
    await expect(makeUser(a, 'u1')).rejects.toMatchObject({ constraint: 'users_account_external_uq' });
  });
});

describe('seed and updated_at', () => {
  it('seeding twice leaves exactly the four predefined plans', async () => {
    await seedPredefinedPlans(t.db);
    await seedPredefinedPlans(t.db);
    const rows = await t.db.select().from(plans).where(eq(plans.isPredefined, true));
    expect(rows.map((r) => r.name).sort()).toEqual(['Basic', 'Pro', 'Premium', 'Starter'].sort());
    expect(rows.every((r) => r.ownerKey === SYSTEM_OWNER_KEY)).toBe(true);
  });

  it('plans.updated_at moves when a plan is updated through Drizzle', async () => {
    const a = await makeAccount('A');
    await c.query('commit'); // Drizzle uses its own connection, so the rows must be visible
    await c.query('begin');
    const planRow = await t.db
      .insert(plans)
      .values({ accountId: a, kind: 'user', name: 'Timestamped', monthlyAllowance: 10, maxUnitsPerRequest: 5 })
      .returning();
    const before = planRow[0]!.updatedAt;
    await new Promise((r) => setTimeout(r, 15));
    const [after] = await t.db.update(plans).set({ monthlyAllowance: 20 }).where(eq(plans.id, planRow[0]!.id)).returning();
    expect(after!.updatedAt.getTime()).toBeGreaterThan(before.getTime());
    // clean up what this test committed
    await t.pool.query('delete from plans where id = $1', [planRow[0]!.id]);
    await t.pool.query('delete from accounts where id = $1', [a]);
  });
});