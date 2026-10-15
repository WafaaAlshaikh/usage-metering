import { and, eq, sql } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { accountUsage, userUsage } from '../db/schema';

/** Creates this month's counter rows when missing, so there is always a row to lock. */
export async function ensureUsageRows(ex: Executor, accountId: string, userId: string, periodStart: string): Promise<void> {
  await ex.insert(accountUsage).values({ accountId, periodStart }).onConflictDoNothing();
  await ex.insert(userUsage).values({ userId, accountId, periodStart }).onConflictDoNothing();
}

/**
 * Locks the account counter, then the user counter (always in this order, so two requests can
 * never wait on each other in a cycle) and returns what was consumed so far this month.
 * Under READ COMMITTED a request that waited for the lock reads the value the previous request
 * committed, which is what makes concurrent decisions correct.
 */
export async function lockUsage(ex: Executor, accountId: string, userId: string, periodStart: string) {
  const [account] = await ex
    .select({ consumed: accountUsage.consumed })
    .from(accountUsage)
    .where(and(eq(accountUsage.accountId, accountId), eq(accountUsage.periodStart, periodStart)))
    .for('update');
  const [user] = await ex
    .select({ consumed: userUsage.consumed })
    .from(userUsage)
    .where(and(eq(userUsage.userId, userId), eq(userUsage.periodStart, periodStart)))
    .for('update');
  if (!account || !user) throw new Error('usage rows are missing right after ensureUsageRows');
  return { accountConsumed: account.consumed, userConsumed: user.consumed };
}

/** Adds accepted units to both counters. Call only while holding the locks from lockUsage. */
export async function addUsage(ex: Executor, accountId: string, userId: string, periodStart: string, units: number): Promise<void> {
  await ex
    .update(accountUsage)
    .set({ consumed: sql`${accountUsage.consumed} + ${units}`, updatedAt: sql`now()` })
    .where(and(eq(accountUsage.accountId, accountId), eq(accountUsage.periodStart, periodStart)));
  await ex
    .update(userUsage)
    .set({ consumed: sql`${userUsage.consumed} + ${units}`, updatedAt: sql`now()` })
    .where(and(eq(userUsage.userId, userId), eq(userUsage.periodStart, periodStart)));
}