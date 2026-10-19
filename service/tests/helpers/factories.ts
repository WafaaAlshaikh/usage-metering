import { and, eq } from 'drizzle-orm';
import type { Db } from '../../src/db/client';
import { accounts, plans, SYSTEM_OWNER_KEY, users } from '../../src/db/schema';
import type { Limits } from '../../src/domain/decision';

let seq = 0;
const next = () => ++seq;

export async function createPlan(db: Db, accountId: string, kind: 'account' | 'user', limits: Limits): Promise<string> {
  const [row] = await db
    .insert(plans)
    .values({
      accountId,
      kind,
      name: `plan-${next()}`,
      monthlyAllowance: limits.monthlyAllowance,
      maxUnitsPerRequest: limits.maxUnitsPerRequest,
    })
    .returning({ id: plans.id });
  return row!.id;
}

export async function updatePlan(db: Db, planId: string, limits: Limits): Promise<void> {
  await db
    .update(plans)
    .set({ monthlyAllowance: limits.monthlyAllowance, maxUnitsPerRequest: limits.maxUnitsPerRequest })
    .where(eq(plans.id, planId));
}

export async function createAccount(db: Db, limits: Limits): Promise<string> {
  const [starter] = await db
    .select({ id: plans.id })
    .from(plans)
    .where(and(eq(plans.name, 'Starter'), eq(plans.isPredefined, true)));
  const [account] = await db
    .insert(accounts)
    .values({
      name: `acct-${next()}`,
      apiKeyHash: `hash-${next()}`,
      apiKeyPrefix: 'k',
      accountPlanId: starter!.id,
      accountPlanOwnerKey: SYSTEM_OWNER_KEY,
    })
    .returning({ id: accounts.id });
  const accountId = account!.id;
  const planId = await createPlan(db, accountId, 'account', limits);
  await db.update(accounts).set({ accountPlanId: planId, accountPlanOwnerKey: accountId }).where(eq(accounts.id, accountId));
  return accountId;
}

export async function createUser(
  db: Db,
  accountId: string,
  externalId: string,
  limits: Limits,
): Promise<{ userId: string; planId: string }> {
  const planId = await createPlan(db, accountId, 'user', limits);
  const [row] = await db
    .insert(users)
    .values({ accountId, externalId, userPlanId: planId, userPlanOwnerKey: accountId })
    .returning({ id: users.id });
  return { userId: row!.id, planId };
}