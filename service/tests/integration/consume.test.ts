import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { users } from '../../src/db/schema';
import { ConflictError, GoneError, NotFoundError } from '../../src/domain/errors';
import { consume, type ConsumeResult } from '../../src/services/consume';
import { createAccount, createPlan, createUser, updatePlan } from '../helpers/factories';
import { setupTestDb, type TestDb } from '../helpers/test-db';

let t: TestDb;
beforeAll(async () => {
  t = await setupTestDb();
});
afterAll(async () => {
  await t.close();
});

let seq = 0;
const ask = (
  accountId: string,
  userId: string,
  units: number,
  extra: { requestId?: string; now?: Date } = {},
): Promise<ConsumeResult> =>
  consume(t.db, { accountId, externalUserId: userId, units, requestId: extra.requestId ?? `req-${++seq}` }, extra.now);

const scalar = async (text: string, params: unknown[]) => Number((await t.pool.query(text, params)).rows[0].v);
const accountConsumed = (accountId: string) =>
  scalar('select coalesce(sum(consumed), 0) as v from account_usage where account_id = $1', [accountId]);
const userConsumed = (accountId: string, externalId: string) =>
  scalar(
    `select coalesce(sum(uu.consumed), 0) as v from user_usage uu
     join users u on u.id = uu.user_id where u.account_id = $1 and u.external_id = $2`,
    [accountId, externalId],
  );
const allUsersConsumed = (accountId: string) =>
  scalar('select coalesce(sum(consumed), 0) as v from user_usage where account_id = $1', [accountId]);
const logCount = (accountId: string) => scalar('select count(*) as v from request_log where account_id = $1', [accountId]);

const limits = (monthlyAllowance: number | null, maxUnitsPerRequest: number | null) => ({ monthlyAllowance, maxUnitsPerRequest });

describe('the examples from the brief', () => {
  it('rejects 25 units by the USER per-request limit, consumes nothing, and logs it', async () => {
    const acc = await createAccount(t.db, limits(10_000, 100));
    await createUser(t.db, acc, 'u1', limits(1_000, 20));
    const r = await ask(acc, 'u1', 25);
    expect(r.accepted).toBe(false);
    expect(r.rejection).toEqual({ scope: 'user', rule: 'max_per_request' });
    expect(await accountConsumed(acc)).toBe(0);
    expect(await userConsumed(acc, 'u1')).toBe(0);
    expect(await logCount(acc)).toBe(1);
  });

  it('accepts 10 units and adds them to both the user and the shared account usage', async () => {
    const acc = await createAccount(t.db, limits(10_000, 100));
    await createUser(t.db, acc, 'u1', limits(1_000, 20));
    const r = await ask(acc, 'u1', 10);
    expect(r.accepted).toBe(true);
    expect(r.account.remaining).toBe(9_990);
    expect(r.user.remaining).toBe(990);
    expect(await accountConsumed(acc)).toBe(10);
    expect(await userConsumed(acc, 'u1')).toBe(10);
  });

  it('rejects 10 units when the account has only 5 left, even though the user has plenty', async () => {
    const acc = await createAccount(t.db, limits(5, 100));
    await createUser(t.db, acc, 'u1', limits(1_000, 20));
    const r = await ask(acc, 'u1', 10);
    expect(r.rejection).toEqual({ scope: 'account', rule: 'monthly_allowance' });
    expect(r.account.remaining).toBe(5);
    expect(await accountConsumed(acc)).toBe(0);
  });
});

describe('idempotency', () => {
  it('a retry returns the original decision and counts the units once', async () => {
    const acc = await createAccount(t.db, limits(100, 50));
    await createUser(t.db, acc, 'u1', limits(100, 50));
    const first = await ask(acc, 'u1', 10, { requestId: 'same' });
    const retry = await ask(acc, 'u1', 10, { requestId: 'same' });
    expect(first.replayed).toBe(false);
    expect(retry).toEqual({ ...first, replayed: true });
    expect(await accountConsumed(acc)).toBe(10);
    expect(await logCount(acc)).toBe(1);
  });

  it('a retried REJECTED request returns the same rejection', async () => {
    const acc = await createAccount(t.db, limits(100, 50));
    await createUser(t.db, acc, 'u1', limits(1_000, 20));
    const first = await ask(acc, 'u1', 25, { requestId: 'r' });
    const retry = await ask(acc, 'u1', 25, { requestId: 'r' });
    expect(retry.replayed).toBe(true);
    expect(retry.rejection).toEqual(first.rejection);
    expect(await logCount(acc)).toBe(1);
  });

  it('the same requestId with different units is a 409 and changes nothing', async () => {
    const acc = await createAccount(t.db, limits(100, 50));
    await createUser(t.db, acc, 'u1', limits(100, 50));
    await ask(acc, 'u1', 5, { requestId: 'x' });
    await expect(ask(acc, 'u1', 6, { requestId: 'x' })).rejects.toBeInstanceOf(ConflictError);
    expect(await accountConsumed(acc)).toBe(5);
    expect(await logCount(acc)).toBe(1);
  });

  it('the same requestId for a different user is a 409', async () => {
    const acc = await createAccount(t.db, limits(100, 50));
    await createUser(t.db, acc, 'u1', limits(100, 50));
    await createUser(t.db, acc, 'u2', limits(100, 50));
    await ask(acc, 'u1', 5, { requestId: 'x' });
    await expect(ask(acc, 'u2', 5, { requestId: 'x' })).rejects.toBeInstanceOf(ConflictError);
  });

  it('the same requestId in two different accounts is not a conflict', async () => {
    const a = await createAccount(t.db, limits(100, 50));
    const b = await createAccount(t.db, limits(100, 50));
    await createUser(t.db, a, 'u1', limits(100, 50));
    await createUser(t.db, b, 'u1', limits(100, 50));
    const ra = await ask(a, 'u1', 5, { requestId: 'shared' });
    const rb = await ask(b, 'u1', 5, { requestId: 'shared' });
    expect(ra.replayed).toBe(false);
    expect(rb.replayed).toBe(false);
  });
});

describe('plan changes', () => {
  it('apply to the next request', async () => {
    const acc = await createAccount(t.db, limits(1_000, 100));
    const user = await createUser(t.db, acc, 'u1', limits(100, 20));
    expect((await ask(acc, 'u1', 30)).rejection).toEqual({ scope: 'user', rule: 'max_per_request' });
    await updatePlan(t.db, user.planId, limits(100, 50));
    const r = await ask(acc, 'u1', 30);
    expect(r.accepted).toBe(true);
    expect(r.user.remaining).toBe(70);
  });

  it('reducing the allowance below usage shows 0 remaining and rejects; history keeps the old limits', async () => {
    const acc = await createAccount(t.db, limits(1_000, 100));
    const user = await createUser(t.db, acc, 'u1', limits(100, 100));
    await ask(acc, 'u1', 60, { requestId: 'before' });
    await updatePlan(t.db, user.planId, limits(50, 50));
    const r = await ask(acc, 'u1', 1);
    expect(r.rejection).toEqual({ scope: 'user', rule: 'monthly_allowance' });
    expect(r.user.remaining).toBe(0);
    const old = await t.pool.query(
      `select user_monthly_allowance from request_log where account_id = $1 and request_id = 'before'`,
      [acc],
    );
    expect(Number(old.rows[0].user_monthly_allowance)).toBe(100);
  });

  it('switching a user to another plan keeps the usage (no fresh allowance)', async () => {
    const acc = await createAccount(t.db, limits(1_000, 100));
    const user = await createUser(t.db, acc, 'u1', limits(100, 100));
    await ask(acc, 'u1', 60);
    const bigger = await createPlan(t.db, acc, 'user', limits(1_000, 50));
    await t.db.update(users).set({ userPlanId: bigger }).where(eq(users.id, user.userId));
    const r = await ask(acc, 'u1', 10);
    expect(r.accepted).toBe(true);
    expect(r.user.remaining).toBe(930);
    expect(await userConsumed(acc, 'u1')).toBe(70);
  });
});

describe('months', () => {
  it('a new UTC month starts at zero while the previous month stays', async () => {
    const acc = await createAccount(t.db, limits(100, 50));
    await createUser(t.db, acc, 'u1', limits(100, 50));
    await ask(acc, 'u1', 10, { now: new Date('2026-10-31T23:59:59Z') });
    const nov = await ask(acc, 'u1', 10, { now: new Date('2026-11-01T00:00:00Z') });
    expect(nov.period).toBe('2026-11');
    expect(nov.user.remaining).toBe(90);
    const rows = await t.pool.query(
      `select to_char(period_start, 'YYYY-MM') as p, consumed from account_usage where account_id = $1 order by period_start`,
      [acc],
    );
    expect(rows.rows.map((r) => [r.p, Number(r.consumed)])).toEqual([
      ['2026-10', 10],
      ['2026-11', 10],
    ]);
  });

    it('the same requestId on both sides of a month boundary is never counted twice', async () => {
    const acc = await createAccount(t.db, limits(100, 50));
    await createUser(t.db, acc, 'u1', limits(100, 50));
    await Promise.allSettled([
      ask(acc, 'u1', 5, { requestId: 'edge', now: new Date('2026-10-31T23:59:59Z') }),
      ask(acc, 'u1', 5, { requestId: 'edge', now: new Date('2026-11-01T00:00:00Z') }),
    ]);
    // Either the second call replays the first, or it hits UNIQUE(account_id, request_id) and rolls back.
    expect(await logCount(acc)).toBe(1);
    expect(await accountConsumed(acc)).toBe(5);
  });
  
});

describe('users', () => {
  it('an unknown user is a 404', async () => {
    const acc = await createAccount(t.db, limits(100, 50));
    await expect(ask(acc, 'ghost', 1)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("another account's user is invisible (same 404)", async () => {
    const a = await createAccount(t.db, limits(100, 50));
    const b = await createAccount(t.db, limits(100, 50));
    await createUser(t.db, a, 'shared-id', limits(100, 50));
    await expect(ask(b, 'shared-id', 1)).rejects.toBeInstanceOf(NotFoundError);
    expect(await accountConsumed(a)).toBe(0);
  });

  it('a soft-deleted user is a 410 and keeps its usage', async () => {
    const acc = await createAccount(t.db, limits(100, 50));
    const user = await createUser(t.db, acc, 'u1', limits(100, 50));
    await ask(acc, 'u1', 10);
    await t.db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, user.userId));
    await expect(ask(acc, 'u1', 1)).rejects.toBeInstanceOf(GoneError);
    expect(await userConsumed(acc, 'u1')).toBe(10);
  });
});

describe('concurrency', () => {
  it('200 parallel requests never exceed the shared allowance', async () => {
    const acc = await createAccount(t.db, limits(50, 10));
    await createUser(t.db, acc, 'u1', limits(1_000, 10));
    const results = await Promise.all(Array.from({ length: 200 }, () => ask(acc, 'u1', 1)));
    expect(results.filter((r) => r.accepted)).toHaveLength(50);
    expect(await accountConsumed(acc)).toBe(50);
    expect(await userConsumed(acc, 'u1')).toBe(50);
    expect(await logCount(acc)).toBe(200);
  });

  it('two parallel requests of 7 against 10 remaining: exactly one wins', async () => {
    const acc = await createAccount(t.db, limits(10, 10));
    await createUser(t.db, acc, 'u1', limits(1_000, 10));
    const results = await Promise.all([ask(acc, 'u1', 7), ask(acc, 'u1', 7)]);
    expect(results.filter((r) => r.accepted)).toHaveLength(1);
    expect(await accountConsumed(acc)).toBe(7);
  });

  it('many users sharing one account allowance never exceed it, and the totals agree', async () => {
    const acc = await createAccount(t.db, limits(100, 10));
    for (let i = 0; i < 10; i++) await createUser(t.db, acc, `u${i}`, limits(1_000, 10));
    const calls = Array.from({ length: 200 }, (_, i) => ask(acc, `u${i % 10}`, 1));
    const results = await Promise.all(calls);
    expect(results.filter((r) => r.accepted)).toHaveLength(100);
    expect(await accountConsumed(acc)).toBe(100);
    expect(await allUsersConsumed(acc)).toBe(100);
  });

  it('20 parallel retries of the same request count once', async () => {
    const acc = await createAccount(t.db, limits(100, 50));
    await createUser(t.db, acc, 'u1', limits(100, 50));
    const results = await Promise.all(Array.from({ length: 20 }, () => ask(acc, 'u1', 5, { requestId: 'dup' })));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.every((r) => r.accepted)).toBe(true);
    expect(await accountConsumed(acc)).toBe(5);
    expect(await logCount(acc)).toBe(1);
  });
});