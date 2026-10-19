import type { Db } from './client';
import { plans } from './schema';

export const DEFAULT_ACCOUNT_PLAN_NAME = 'Starter';
export const DEFAULT_USER_PLAN_NAME = 'Basic';

export const PREDEFINED_PLANS = [
  { kind: 'account', name: 'Starter', monthlyAllowance: 10_000, maxUnitsPerRequest: 100 },
  { kind: 'account', name: 'Pro', monthlyAllowance: 1_000_000, maxUnitsPerRequest: 1_000 },
  { kind: 'user', name: 'Basic', monthlyAllowance: 1_000, maxUnitsPerRequest: 20 },
  { kind: 'user', name: 'Premium', monthlyAllowance: 5_000, maxUnitsPerRequest: 200 },
] as const;


export async function seedPredefinedPlans(db: Db): Promise<void> {
  await db
    .insert(plans)
    .values(
      PREDEFINED_PLANS.map((p) => ({
        ...p,
        accountId: null,
        isPredefined: true,
      })),
    )
    .onConflictDoNothing();
}