import type { Db, Executor } from '../db/client';
import { isUniqueViolation } from '../db/pgErrors';
import type { RequestLogRow } from '../db/schema';
import type { Limits, Rejection } from '../domain/decision';
import { ConflictError, GoneError, NotFoundError } from '../domain/errors';
import { periodLabel, periodStartOf } from '../domain/period';
import { evaluate } from '../domain/rules';
import { findPlansForUser } from '../repo/plans';
import { findByRequestId, insertRequestLog } from '../repo/requestLog';
import { addUsage, currentPeriodStart, lockUsage } from '../repo/usage';
import { findUserByExternalId } from '../repo/users';

/** Returns the UTC month ('YYYY-MM-01') to account a request to. Replaceable in tests. */
export type PeriodSource = (ex: Executor) => Promise<string>;

/** Thrown inside the transaction (so it rolls back) when the month changed while waiting for the locks. */
class MonthChanged extends Error {}

const MAX_ATTEMPTS = 3; // the month can change at most once in practice; 3 is a safety margin


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
 * The month a request belongs to is the month at the moment it is DECIDED, i.e. when it holds
 * the usage locks, not when it arrived. Because the lock is taken on a specific month's row,
 * the month is read first, the locks are taken, and the month is read again: if it changed while
 * waiting, the transaction rolls back and starts over on the new month's counters.
 * `now` (tests) pins the month; otherwise the database clock decides.
 *
 * One database transaction:
 *   1. find the user inside the calling account (404 otherwise)
 *   2. a saved result for this requestId is returned as a replay, even if the user was deleted
 *      since (fast path, no locks, nothing is created)
 *   3. a deleted user cannot consume anything new (410)
 *   4. read the month, lock account counter -> user counter (creating the month's rows only if
 *      missing), read the month again
 *   5. look the requestId up again (after the locks, so identical concurrent requests queue up
 *      and the later ones see the earlier one's result)
 *   6. read both plans (after the locks: a request's plans are fixed when it gets the locks; an
 *      update that completed before that moment applies, one that completes later does not)
 *   7. evaluate the rules (pure function)
 *   8. if accepted, add the units to both counters
 *   9. write the request_log row (accepted or rejected)
 * The allowance can never be exceeded by concurrent requests. The price is that requests of one
 * account run one after another.
 */
export async function consume(
  db: Db,
  input: ConsumeInput,
  now?: Date,
  periodSource?: PeriodSource,
): Promise<ConsumeResult> {
  const readPeriod: PeriodSource =
    periodSource ?? (now ? async () => periodStartOf(now) : currentPeriodStart);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await consumeInMonth(db, input, readPeriod);
    } catch (err) {
      if (!(err instanceof MonthChanged)) throw err;
    }
  }
  throw new Error('the month changed repeatedly while one request was waiting');
}

async function consumeInMonth(db: Db, input: ConsumeInput, readPeriod: PeriodSource): Promise<ConsumeResult> {
  return db.transaction(async (tx) => {
    const user = await findUserByExternalId(tx, input.accountId, input.externalUserId);
    if (!user) {
      throw new NotFoundError(`User "${input.externalUserId}" is not registered for this account`);
    }

    // A retry gets the original answer even if the user was deleted after the first attempt.
    const saved = await findByRequestId(tx, input.accountId, input.requestId);
    if (saved) return replayOf(saved, user.id, input);

    if (user.deletedAt) {
      throw new GoneError(`User "${input.externalUserId}" has been deleted`);
    }

    const periodStart = await readPeriod(tx);
    const usage = await lockUsage(tx, input.accountId, user.id, periodStart);
    if ((await readPeriod(tx)) !== periodStart) throw new MonthChanged();

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
 * Same as consume(), plus one re-run for a rare race: the same requestId arriving while the month
 * flips can lock different usage rows, so two transactions run in parallel and the second hits
 * UNIQUE (account_id, request_id). It rolled back, so nothing was counted; running it again finds
 * the first result and answers with a replay.
 */
export async function consumeWithRetry(db: Db, input: ConsumeInput, now?: Date): Promise<ConsumeResult> {
  try {
    return await consume(db, input, now);
  } catch (err) {
    if (isUniqueViolation(err, 'request_log_account_request_uq')) return consume(db, input, now);
    throw err;
  }
}
