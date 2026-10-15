import { eq, and, isNull, or, asc, sql } from 'drizzle-orm';
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
    .limit(1)
    .for('share');
  return row ?? null;
}

export async function findPlanById(ex: Executor, planId: string) {
  const [row] = await ex.select().from(plans).where(eq(plans.id, planId)).limit(1);
  return row ?? null;
}

/** A plan this account can see: predefined or its own (archived included). Others' plans are null. */
export async function findVisiblePlan(ex: Executor, accountId: string, planId: string) {
  const [row] = await ex
    .select()
    .from(plans)
    .where(and(eq(plans.id, planId), or(isNull(plans.accountId), eq(plans.accountId, accountId))))
    .limit(1);
  return row ?? null;
}

export async function listVisiblePlans(
  ex: Executor,
  accountId: string,
  opts: { kind?: 'account' | 'user'; includeArchived: boolean },
) {
  const conditions = [or(isNull(plans.accountId), eq(plans.accountId, accountId))];
  if (opts.kind) conditions.push(eq(plans.kind, opts.kind));
  if (!opts.includeArchived) conditions.push(isNull(plans.archivedAt));
  return ex
    .select()
    .from(plans)
    .where(and(...conditions))
    .orderBy(asc(plans.kind), asc(plans.name));
}

export async function insertPlan(ex: Executor, row: typeof plans.$inferInsert) {
  const [created] = await ex.insert(plans).values(row).returning();
  return created!;
}

/** updated_at moves through $onUpdate (database clock). Undefined fields are left unchanged. */
export async function updatePlanRow(
  ex: Executor,
  planId: string,
  patch: { name?: string; monthlyAllowance?: number | null; maxUnitsPerRequest?: number | null },
) {
  const [row] = await ex.update(plans).set(patch).where(eq(plans.id, planId)).returning();
  return row!;
}

export async function archivePlanRow(ex: Executor, planId: string) {
  const [row] = await ex
    .update(plans)
    .set({ archivedAt: sql`now()` })
    .where(and(eq(plans.id, planId), isNull(plans.archivedAt)))
    .returning();
  return row ?? null; // null = it was already archived
}