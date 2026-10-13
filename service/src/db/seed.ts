import type { Db } from './client';
import { plans } from './schema';

export const DEFAULT_ACCOUNT_PLAN_NAME = 'Starter';
export const DEFAULT_USER_PLAN_NAME = 'Basic';

/**
 * Predefined plans (read-only, available to every account).
 * Units are "document processing credits".
 *
 *   kind     name      monthly allowance   max per request
 *   account  Starter        10,000               100
 *   account  Pro         1,000,000             1,000
 *   user     Basic           1,000                20
 *   user     Premium         5,000               200
 */
export const PREDEFINED_PLANS = [
  { kind: 'account', name: 'Starter', monthlyAllowance: 10_000, maxUnitsPerRequest: 100 },
  { kind: 'account', name: 'Pro', monthlyAllowance: 1_000_000, maxUnitsPerRequest: 1_000 },
  { kind: 'user', name: 'Basic', monthlyAllowance: 1_000, maxUnitsPerRequest: 20 },
  { kind: 'user', name: 'Premium', monthlyAllowance: 5_000, maxUnitsPerRequest: 200 },
] as const;

/**
 * Idempotent: safe to run on every startup. Existing rows are left untouched, so editing the
 * numbers above does not silently change limits for accounts already using a predefined plan.
 */
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