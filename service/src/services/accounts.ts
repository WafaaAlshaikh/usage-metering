import type { Db } from '../db/client';
import { SYSTEM_OWNER_KEY } from '../db/schema';
import { generateApiKey, hashApiKey, prefixOf } from '../domain/apiKey';
import { BadRequestError } from '../domain/errors';
import { findPredefinedPlan, insertAccount } from '../repo/accounts';

export const DEFAULT_ACCOUNT_PLAN = 'Starter';

export interface RegisterAccountInput {
  name: string;
  /** Name of a predefined ACCOUNT plan. Defaults to Starter. */
  planName?: string;
}

export interface RegisteredAccount {
  id: string;
  name: string;
  apiKeyPrefix: string;
  planId: string;
  createdAt: Date;
  /** The raw key. Returned exactly once, never stored. */
  apiKey: string;
}

export async function registerAccount(db: Db, input: RegisterAccountInput): Promise<RegisteredAccount> {
  const planName = input.planName ?? DEFAULT_ACCOUNT_PLAN;
  const plan = await findPredefinedPlan(db, 'account', planName);
  if (!plan) {
    throw new BadRequestError(`"${planName}" is not a predefined account plan`, { planName });
  }

  const apiKey = generateApiKey();
  const account = await insertAccount(db, {
    name: input.name,
    apiKeyHash: hashApiKey(apiKey),
    apiKeyPrefix: prefixOf(apiKey),
    accountPlanId: plan.id,
    accountPlanOwnerKey: SYSTEM_OWNER_KEY,
  });

  return {
    id: account.id,
    name: account.name,
    apiKeyPrefix: account.apiKeyPrefix,
    planId: account.accountPlanId,
    createdAt: account.createdAt,
    apiKey,
  };
}