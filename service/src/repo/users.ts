import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { plans, users } from '../db/schema';

export async function findUserByExternalId(ex: Executor, accountId: string, externalId: string) {
  const [row] = await ex
    .select()
    .from(users)
    .where(and(eq(users.accountId, accountId), eq(users.externalId, externalId)))
    .limit(1);
  return row ?? null;
}

export async function insertUser(ex: Executor, row: typeof users.$inferInsert) {
  const [created] = await ex.insert(users).values(row).returning();
  return created!;
}

export async function reactivateUser(
  ex: Executor,
  userId: string,
  plan?: { id: string; ownerKey: string },
) {
  const [row] = await ex
    .update(users)
    .set({
      deletedAt: null,
      ...(plan ? { userPlanId: plan.id, userPlanOwnerKey: plan.ownerKey } : {}),
    })
    .where(eq(users.id, userId))
    .returning();
  return row!;
}

export async function updateUserPlan(ex: Executor, userId: string, plan: { id: string; ownerKey: string }) {
  const [row] = await ex
    .update(users)
    .set({ userPlanId: plan.id, userPlanOwnerKey: plan.ownerKey })
    .where(eq(users.id, userId))
    .returning();
  return row!;
}

export async function markUserDeleted(ex: Executor, userId: string) {
  await ex.update(users).set({ deletedAt: sql`now()` }).where(eq(users.id, userId));
}

export async function findUserWithPlan(ex: Executor, accountId: string, externalId: string) {
  const [row] = await ex
    .select({ user: users, plan: plans })
    .from(users)
    .innerJoin(plans, eq(plans.id, users.userPlanId))
    .where(and(eq(users.accountId, accountId), eq(users.externalId, externalId)))
    .limit(1);
  return row ?? null;
}

export async function listUsersWithPlans(ex: Executor, accountId: string, limit: number, after?: string) {
  return ex
    .select({ user: users, plan: plans })
    .from(users)
    .innerJoin(plans, eq(plans.id, users.userPlanId))
    .where(
      and(
        eq(users.accountId, accountId),
        isNull(users.deletedAt),
        after === undefined ? undefined : gt(users.externalId, after),
      ),
    )
    .orderBy(asc(users.externalId))
    .limit(limit + 1);
}