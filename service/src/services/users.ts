import type { Db } from '../db/client';
import { isUniqueViolation } from '../db/pgErrors';
import { ConflictError, GoneError, NotFoundError } from '../domain/errors';
import { findPredefinedPlan } from '../repo/accounts';
import { findAssignablePlan } from '../repo/plans';
import {
  findUserByExternalId,
  insertUser,
  markUserDeleted,
  reactivateUser,
  updateUserPlan,
} from '../repo/users';

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

export async function assignUserPlan(db: Db, input: { accountId: string; externalId: string; planId: string }) {
  return db.transaction(async (tx) => {
    const user = await findUserByExternalId(tx, input.accountId, input.externalId);
    if (!user) throw new NotFoundError(`User "${input.externalId}" is not registered for this account`);
    if (user.deletedAt) throw new GoneError(`User "${input.externalId}" has been deleted`);

    const plan = await findAssignablePlan(tx, input.accountId, input.planId, 'user');
    if (!plan) throw new NotFoundError('User plan not found for this account', { planId: input.planId });
    // Re-assigning the plan the user already has is harmless even if it was archived since.
    if (plan.archivedAt && plan.id !== user.userPlanId) {
      throw new ConflictError('plan_archived', 'This plan is archived and cannot be assigned to anyone new', {
        planId: plan.id,
      });
    }
    // Usage is stored per user and month, not per plan, so switching never resets it.
    const updated = await updateUserPlan(tx, user.id, plan);
    return { user: updated, plan };
  });
}

/** Soft delete. Usage and history stay; registering the same externalId again re-activates it. */
export async function removeUser(db: Db, accountId: string, externalId: string): Promise<void> {
  const user = await findUserByExternalId(db, accountId, externalId);
  if (!user) throw new NotFoundError(`User "${externalId}" is not registered for this account`);
  if (!user.deletedAt) await markUserDeleted(db, user.id);
}