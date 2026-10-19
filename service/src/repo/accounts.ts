import { and, eq, isNull } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { accounts, plans } from '../db/schema';

export async function findPredefinedPlan(ex: Executor, kind: 'account' | 'user', name: string) {
  const [row] = await ex
    .select()
    .from(plans)
    .where(and(eq(plans.kind, kind), eq(plans.name, name), isNull(plans.accountId)))
    .limit(1);
  return row ?? null;
}

export async function insertAccount(ex: Executor, row: typeof accounts.$inferInsert) {
  const [created] = await ex.insert(accounts).values(row).returning();
  return created!;
}

export async function findAccountByKeyHash(ex: Executor, apiKeyHash: string) {
  const [row] = await ex.select().from(accounts).where(eq(accounts.apiKeyHash, apiKeyHash)).limit(1);
  return row ?? null;
}

export async function updateAccountPlan(ex: Executor, accountId: string, plan: { id: string; ownerKey: string }) {
  const [row] = await ex
    .update(accounts)
    .set({ accountPlanId: plan.id, accountPlanOwnerKey: plan.ownerKey })
    .where(eq(accounts.id, accountId))
    .returning();
  return row!;
}

export async function findAccountById(ex: Executor, accountId: string) {
  const [row] = await ex.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  return row ?? null;
}