import { and, eq } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { users } from '../db/schema';

/** Looks the user up inside the calling account only, so another account's users are invisible. */
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

/** Re-activates a soft-deleted user (keeps its usage). Optionally moves it to another plan. */
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