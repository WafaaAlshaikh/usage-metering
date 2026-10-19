import { and, asc, eq, gt, isNotNull, isNull, or } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { accountUsage, plans, userUsage, users } from '../db/schema';

export async function getAccountConsumed(ex: Executor, accountId: string, periodStart: string): Promise<number> {
  const [row] = await ex
    .select({ consumed: accountUsage.consumed })
    .from(accountUsage)
    .where(and(eq(accountUsage.accountId, accountId), eq(accountUsage.periodStart, periodStart)))
    .limit(1);
  return row?.consumed ?? 0;
}


export async function listUserUsage(
  ex: Executor,
  accountId: string,
  periodStart: string,
  limit: number,
  after?: string | undefined,
) {
  return ex
    .select({ user: users, plan: plans, consumed: userUsage.consumed })
    .from(users)
    .innerJoin(plans, eq(plans.id, users.userPlanId))
    .leftJoin(userUsage, and(eq(userUsage.userId, users.id), eq(userUsage.periodStart, periodStart)))
    .where(
      and(
        eq(users.accountId, accountId),
        or(isNull(users.deletedAt), isNotNull(userUsage.consumed)),
        after === undefined ? undefined : gt(users.externalId, after),
      ),
    )
    .orderBy(asc(users.externalId))
    .limit(limit + 1);
}