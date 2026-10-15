import type { Db } from '../db/client';
import { isUniqueViolation } from '../db/pgErrors';
import { ConflictError, NotFoundError } from '../domain/errors';
import { findPredefinedPlan } from '../repo/accounts';
import { findAssignablePlan } from '../repo/plans';
import { findUserByExternalId, insertUser, reactivateUser } from '../repo/users';

export const DEFAULT_USER_PLAN = 'Basic';

export interface RegisterUserInput {
  accountId: string; // from the API key
  externalId: string;
  /** A predefined user plan or one of the account's own. Defaults to Basic. */
  planId?: string;
}

export async function registerUser(db: Db, input: RegisterUserInput) {
  return db.transaction(async (tx) => {
    const plan = input.planId
      ? await findAssignablePlan(tx, input.accountId, input.planId, 'user')
      : await findPredefinedPlan(tx, 'user', DEFAULT_USER_PLAN);
    if (!plan) throw new NotFoundError('User plan not found for this account', { planId: input.planId });
    if (plan.archivedAt) {
      throw new ConflictError('plan_archived', 'This plan is archived and cannot be assigned to anyone new', {
        planId: plan.id,
      });
    }

    const existing = await findUserByExternalId(tx, input.accountId, input.externalId);
    if (existing) {
      if (!existing.deletedAt) {
        throw new ConflictError('user_exists', `User "${input.externalId}" is already registered`);
      }
      // Re-activation keeps usage. The plan changes only if the caller named one.
      const user = await reactivateUser(tx, existing.id, input.planId ? plan : undefined);
      return { user, created: false };
    }

    try {
      const user = await insertUser(tx, {
        accountId: input.accountId,
        externalId: input.externalId,
        userPlanId: plan.id,
        userPlanOwnerKey: plan.ownerKey,
      });
      return { user, created: true };
    } catch (err) {
      if (isUniqueViolation(err, 'users_account_external_uq')) {
        throw new ConflictError('user_exists', `User "${input.externalId}" is already registered`);
      }
      throw err;
    }
  });
}