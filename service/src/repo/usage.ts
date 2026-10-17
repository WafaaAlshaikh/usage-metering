import { and, eq, sql } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { accountUsage, userUsage } from '../db/schema';

/**
 * Locks the account's counter row for the month and returns what was consumed so far.
 * The normal path is a single SELECT ... FOR UPDATE. Only the first request of a month finds no
 * row: it inserts one (ON CONFLICT DO NOTHING, so a concurrent first request is harmless) and
 * selects again. Under READ COMMITTED a request that waited for the lock reads the value the
 * previous request committed, which is what makes concurrent decisions correct.
 */
async function lockAccountRow(ex: Executor, accountId: string, periodStart: string): Promise<number> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const [row] = await ex
      .select({ consumed: accountUsage.consumed })
      .from(accountUsage)
      .where(and(eq(accountUsage.accountId, accountId), eq(accountUsage.periodStart, periodStart)))
      .for('update');
    if (row) return row.consumed;
    await ex.insert(accountUsage).values({ accountId, periodStart }).onConflictDoNothing();
  }
  throw new Error('account usage row is missing right after it was created');
}

async function lockUserRow(ex: Executor, accountId: string, userId: string, periodStart: string): Promise<number> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const [row] = await ex
      .select({ consumed: userUsage.consumed })
      .from(userUsage)
      .where(and(eq(userUsage.userId, userId), eq(userUsage.periodStart, periodStart)))
      .for('update');
    if (row) return row.consumed;
    await ex.insert(userUsage).values({ userId, accountId, periodStart }).onConflictDoNothing();
  }
  throw new Error('user usage row is missing right after it was created');
}

/**
 * Locks the account counter, then the user counter (always in this order, so two requests can
 * never wait on each other in a cycle) and returns what was consumed so far this month.
 * Creates the month's rows when they do not exist yet.
 */
export async function lockUsage(ex: Executor, accountId: string, userId: string, periodStart: string) {
  const accountConsumed = await lockAccountRow(ex, accountId, periodStart);
  const userConsumed = await lockUserRow(ex, accountId, userId, periodStart);
  return { accountConsumed, userConsumed };
}

/**
 * Adds accepted units to both counters in ONE statement (one round trip). Both rows are already
 * locked by lockUsage, so this cannot interleave with another request.
 */
export async function addUsage(
  ex: Executor,
  accountId: string,
  userId: string,
  periodStart: string,
  units: number,
): Promise<void> {
  await ex.execute(sql`
    with a as (
      update account_usage
         set consumed = consumed + ${units}::bigint, updated_at = now()
       where account_id = ${accountId}::uuid and period_start = ${periodStart}::date
    )
    update user_usage
       set consumed = consumed + ${units}::bigint, updated_at = now()
     where user_id = ${userId}::uuid and period_start = ${periodStart}::date
  `);
}

/**
 * The current UTC month ('YYYY-MM-01') by the DATABASE clock. Used instead of the app server's
 * clock so every service instance agrees, and so the month can be re-read after waiting for a lock.
 */
export async function currentPeriodStart(ex: Executor): Promise<string> {
  const res = await ex.execute(
    sql`select to_char(date_trunc('month', clock_timestamp() at time zone 'UTC'), 'YYYY-MM-DD') as p`,
  );
  return (res.rows[0] as { p: string }).p;
}