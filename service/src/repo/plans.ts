import { eq, and, isNull, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Executor } from '../db/client';
import { accounts, plans, users } from '../db/schema';

const userPlan = alias(plans, 'user_plan');
const accountPlan = alias(plans, 'account_plan');

/** The plan currently assigned to a user and the plan of that user's account, in one query. */
export async function findPlansForUser(ex: Executor, userId: string) {
  const [row] = await ex
    .select({ userPlan, accountPlan })
    .from(users)
    .innerJoin(accounts, eq(accounts.id, users.accountId))
    .innerJoin(userPlan, eq(userPlan.id, users.userPlanId))
    .innerJoin(accountPlan, eq(accountPlan.id, accounts.accountPlanId))
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? null;
}

/**
 * A plan of the given kind that this account may assign: a predefined plan or one of its own.
 * Another account's plan comes back as null, exactly like a plan that does not exist.
 */
export async function findAssignablePlan(ex: Executor, accountId: string, planId: string, kind: 'account' | 'user') {
  const [row] = await ex
    .select()
    .from(plans)
    .where(
      and(
        eq(plans.id, planId),
        eq(plans.kind, kind),
        or(isNull(plans.accountId), eq(plans.accountId, accountId)),
      ),
    )
    .limit(1);
  return row ?? null;
}