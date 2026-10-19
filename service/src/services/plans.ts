import type { Db } from '../db/client';
import { isUniqueViolation } from '../db/pgErrors';
import { ConflictError, ForbiddenError, NotFoundError } from '../domain/errors';
import { archivePlanRow, findVisiblePlan, insertPlan, updatePlanRow } from '../repo/plans';

export interface NewPlan {
  kind: 'account' | 'user';
  name: string;
  monthlyAllowance: number | null;
  maxUnitsPerRequest: number | null;
}

export interface PlanPatch {
  name?: string;
  monthlyAllowance?: number | null;
  maxUnitsPerRequest?: number | null;
}

const nameTaken = (name: string) =>
  new ConflictError('plan_name_taken', `You already have a plan of this kind named "${name}"`, { name });

export async function createCustomPlan(db: Db, accountId: string, input: NewPlan) {
  try {
    return await insertPlan(db, { accountId, ...input });
  } catch (err) {
    if (isUniqueViolation(err, 'plans_custom_name_uq')) throw nameTaken(input.name);
    throw err;
  }
}

async function ownPlanOrThrow(db: Db, accountId: string, planId: string) {
  const plan = await findVisiblePlan(db, accountId, planId);
  if (!plan) throw new NotFoundError('Plan not found', { planId });
  if (plan.isPredefined) {
    throw new ForbiddenError('plan_read_only', 'Predefined plans are read-only', { planId });
  }
  return plan;
}

export async function updateCustomPlan(db: Db, accountId: string, planId: string, patch: PlanPatch) {
  await ownPlanOrThrow(db, accountId, planId);
  try {
    return await updatePlanRow(db, planId, patch);
  } catch (err) {
    if (patch.name && isUniqueViolation(err, 'plans_custom_name_uq')) throw nameTaken(patch.name);
    throw err;
  }
}

export async function archiveCustomPlan(db: Db, accountId: string, planId: string) {
  const plan = await ownPlanOrThrow(db, accountId, planId);
  return (await archivePlanRow(db, planId)) ?? plan;
}