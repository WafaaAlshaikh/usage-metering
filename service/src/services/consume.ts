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

export type PeriodSource = (ex: Executor) => Promise<string>;

class MonthChanged extends Error {}

const MAX_ATTEMPTS = 3;


export interface ConsumeInput {
  accountId: string; 
  externalUserId: string;
  requestId: string;
  units: number;
}

export interface ScopeOutcome {
  planId: string;
  limits: Limits;
  remaining: number | null;
}

export interface ConsumeResult {
  requestId: string;
  userId: string; 
  units: number;
  accepted: boolean;
  replayed: boolean;
  period: string; 
  rejection: Rejection | null;
  account: ScopeOutcome;
  user: ScopeOutcome;
}

const limitsOf = (plan: { monthlyAllowance: number | null; maxUnitsPerRequest: number | null }): Limits => ({
  monthlyAllowance: plan.monthlyAllowance,
  maxUnitsPerRequest: plan.maxUnitsPerRequest,
});


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


export async function consumeWithRetry(db: Db, input: ConsumeInput, now?: Date): Promise<ConsumeResult> {
  try {
    return await consume(db, input, now);
  } catch (err) {
    if (isUniqueViolation(err, 'request_log_account_request_uq')) return consume(db, input, now);
    throw err;
  }
}
