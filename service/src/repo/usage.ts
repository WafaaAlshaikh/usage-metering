import { and, eq, sql } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { accountUsage, userUsage } from '../db/schema';


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


export async function lockUsage(ex: Executor, accountId: string, userId: string, periodStart: string) {
  const accountConsumed = await lockAccountRow(ex, accountId, periodStart);
  const userConsumed = await lockUserRow(ex, accountId, userId, periodStart);
  return { accountConsumed, userConsumed };
}


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


export async function currentPeriodStart(ex: Executor): Promise<string> {
  const res = await ex.execute(
    sql`select to_char(date_trunc('month', clock_timestamp() at time zone 'UTC'), 'YYYY-MM-DD') as p`,
  );
  return (res.rows[0] as { p: string }).p;
}