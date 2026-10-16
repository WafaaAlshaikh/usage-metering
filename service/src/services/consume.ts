import type { Db } from '../db/client';
import { isUniqueViolation } from '../db/pgErrors';
import type { RequestLogRow } from '../db/schema';
import type { Limits, Rejection } from '../domain/decision';
import { ConflictError, GoneError, NotFoundError } from '../domain/errors';
import { periodLabel, periodStartOf } from '../domain/period';
import { evaluate } from '../domain/rules';
import { findPlansForUser } from '../repo/plans';
import { findByRequestId, insertRequestLog } from '../repo/requestLog';
import { addUsage, lockUsage } from '../repo/usage';
import { findUserByExternalId } from '../repo/users';

export interface ConsumeInput {
  accountId: string; // from the API key, never from the request body
  externalUserId: string;
  requestId: string;
  units: number;
}

/** What one side (account or user) looked like when the decision was made. */
export interface ScopeOutcome {
  planId: string;
  limits: Limits;
  /** Monthly allowance left after this decision (null = unlimited). */
  remaining: number | null;
}

export interface ConsumeResult {
  requestId: string;
  userId: string; // the caller's external id
  units: number;
  accepted: boolean;
  /** True when this is the stored answer to an earlier identical request (a safe retry). */
  replayed: boolean;
  period: string; // 'YYYY-MM' (UTC)
  rejection: Rejection | null;
  account: ScopeOutcome;
  user: ScopeOutcome;
}

const limitsOf = (plan: { monthlyAllowance: number | null; maxUnitsPerRequest: number | null }): Limits => ({
  monthlyAllowance: plan.monthlyAllowance,
  maxUnitsPerRequest: plan.maxUnitsPerRequest,
});

/**
 * Decides and records one consume request, atomically.
 *
 * One database transaction:
 *   1. find the user inside the calling account (404 / 410 otherwise)
 *   2. lock account counter -> user counter (creating this month's rows only if missing) *   3. look the requestId up (after the locks, so identical concurrent requests queue up
 *      and the later ones see the earlier one's result)
 *   4. read both plans (after the locks, so the decision uses the plans as they are now)
 *   5. evaluate the rules (pure function)
 *   6. if accepted, add the units to both counters
 *   7. write the request_log row (accepted or rejected)
 * Because the counters are locked from step 2 to the commit, the allowance can never be exceeded
 * by concurrent requests. The price is that requests of one account run one after another.
 */
export async function consume(db: Db, input: ConsumeInput, now: Date = new Date()): Promise<ConsumeResult> {
  const periodStart = periodStartOf(now);

  return db.transaction(async (tx) => {
    const user = await findUserByExternalId(tx, input.accountId, input.externalUserId);
    if (!user) {
      throw new NotFoundError(`User "${input.externalUserId}" is not registered for this account`);
    }
    if (user.deletedAt) {
      throw new GoneError(`User "${input.externalUserId}" has been deleted`);
    }

    const usage = await lockUsage(tx, input.accountId, user.id, periodStart);

    const previous = await findByRequestId(tx, input.accountId, input.requestId);
    if (previous) return replayOf(previous, user.id, input);

    const current = await findPlansForUser(tx, user.id);
    if (!current) throw new Error('user row exists but its plans could not be loaded');
    const { userPlan, accountPlan } = current;

    const decision = evaluate({
      units: input.units,
      account: { limits: limitsOf(accountPlan), consumed: usage.accountConsumed },
      user: { limits: limitsOf(userPlan), consumed: usage.userConsumed },
    });

    if (decision.accepted) {
      await addUsage(tx, input.accountId, user.id, periodStart, input.units);
    }

    await insertRequestLog(tx, {
      accountId: input.accountId,
      userId: user.id,
      requestId: input.requestId,
      units: input.units,
      accepted: decision.accepted,
      rejectedBy: decision.rejection?.scope ?? null,
      rejectedRule: decision.rejection?.rule ?? null,
      periodStart,
      accountPlanId: accountPlan.id,
      userPlanId: userPlan.id,
      accountMonthlyAllowance: accountPlan.monthlyAllowance,
      accountMaxPerRequest: accountPlan.maxUnitsPerRequest,
      userMonthlyAllowance: userPlan.monthlyAllowance,
      userMaxPerRequest: userPlan.maxUnitsPerRequest,
      accountRemainingAfter: decision.accountRemainingAfter,
      userRemainingAfter: decision.userRemainingAfter,
    });

    return {
      requestId: input.requestId,
      userId: input.externalUserId,
      units: input.units,
      accepted: decision.accepted,
      replayed: false,
      period: periodLabel(periodStart),
      rejection: decision.rejection,
      account: { planId: accountPlan.id, limits: limitsOf(accountPlan), remaining: decision.accountRemainingAfter },
      user: { planId: userPlan.id, limits: limitsOf(userPlan), remaining: decision.userRemainingAfter },
    };
  });
}

/**
 * A repeated requestId: the same user and units get the original decision back, nothing is
 * counted again. A different user or amount is a client bug, not a retry, so it is a 409.
 */
function replayOf(previous: RequestLogRow, userId: string, input: ConsumeInput): ConsumeResult {
  if (previous.userId !== userId || previous.units !== input.units) {
    throw new ConflictError(
      'idempotency_conflict',
      `requestId "${input.requestId}" was already used for a different request; a retry must use the same user and units`,
      { requestId: input.requestId, originalUnits: previous.units },
    );
  }
  return {
    requestId: previous.requestId,
    userId: input.externalUserId,
    units: previous.units,
    accepted: previous.accepted,
    replayed: true,
    period: periodLabel(previous.periodStart),
    rejection: previous.accepted ? null : { scope: previous.rejectedBy!, rule: previous.rejectedRule! },
    account: {
      planId: previous.accountPlanId,
      limits: { monthlyAllowance: previous.accountMonthlyAllowance, maxUnitsPerRequest: previous.accountMaxPerRequest },
      remaining: previous.accountRemainingAfter,
    },
    user: {
      planId: previous.userPlanId,
      limits: { monthlyAllowance: previous.userMonthlyAllowance, maxUnitsPerRequest: previous.userMaxPerRequest },
      remaining: previous.userRemainingAfter,
    },
  };
}

/**
 * Same as consume(), plus one retry for a rare race: the same requestId arriving on both sides of
 * a month boundary locks different usage rows, so both transactions run in parallel and the second
 * one hits UNIQUE (account_id, request_id). The transaction rolled back, so nothing was counted;
 * running it again finds the first result and answers with a replay.
 */
export async function consumeWithRetry(db: Db, input: ConsumeInput): Promise<ConsumeResult> {
  try {
    return await consume(db, input);
  } catch (err) {
    if (isUniqueViolation(err, 'request_log_account_request_uq')) return consume(db, input);
    throw err;
  }
}