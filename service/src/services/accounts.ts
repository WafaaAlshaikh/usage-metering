import type { Db } from '../db/client';
import { SYSTEM_OWNER_KEY } from '../db/schema';
import { generateApiKey, hashApiKey, prefixOf } from '../domain/apiKey';
import { BadRequestError, ConflictError, NotFoundError } from '../domain/errors';
import { findAccountById, findPredefinedPlan, insertAccount, updateAccountPlan } from '../repo/accounts';
import { findAssignablePlan } from '../repo/plans';

export const DEFAULT_ACCOUNT_PLAN = 'Starter';

export interface RegisterAccountInput {
  name: string;
  planName?: string;
}

export interface RegisteredAccount {
  id: string;
  name: string;
  apiKeyPrefix: string;
  planId: string;
  createdAt: Date;
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

export async function assignAccountPlan(db: Db, accountId: string, planId: string) {
  return db.transaction(async (tx) => {
    const current = await findAccountById(tx, accountId);
    if (!current) throw new NotFoundError('Account not found');
    const plan = await findAssignablePlan(tx, accountId, planId, 'account');
    if (!plan) throw new NotFoundError('Account plan not found for this account', { planId });
    if (plan.archivedAt && plan.id !== current.accountPlanId) {
      throw new ConflictError('plan_archived', 'This plan is archived and cannot be assigned to anyone new', {
        planId: plan.id,
      });
    }
    return { account: await updateAccountPlan(tx, accountId, plan), plan };
  });
}