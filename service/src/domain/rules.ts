import type { Decision, Limits, Rejection, RuleType, Scope } from './decision';

/** One side of the check: the plan's limits plus what was already consumed this month. */
export interface ScopeState {
  limits: Limits;
  consumed: number;
}

export interface EvaluationInput {
  units: number;
  account: ScopeState;
  user: ScopeState;
}

/** Units left this month. `null` = unlimited. Never negative (see "allowance reduced" below). */
export function remainingAllowance(limits: Limits, consumed: number): number | null {
  if (limits.monthlyAllowance === null) return null;
  return Math.max(0, limits.monthlyAllowance - consumed);
}

const reject = (scope: Scope, rule: RuleType): Rejection => ({ scope, rule });

const exceedsPerRequest = (units: number, limits: Limits): boolean =>
  limits.maxUnitsPerRequest !== null && units > limits.maxUnitsPerRequest;

// If a plan is edited so the allowance drops below what was already consumed, consumed >
// allowance, so any positive request fails here and the remaining amount reports as 0.
const exceedsAllowance = (units: number, state: ScopeState): boolean =>
  state.limits.monthlyAllowance !== null && state.consumed + units > state.limits.monthlyAllowance;

/**
 * Pure decision: no database, no clock, no side effects.
 * The request is accepted only if EVERY rule of BOTH plans allows the full amount.
 *
 * When several rules would reject, we report the first one in this fixed order:
 *   1. user    max_per_request
 *   2. account max_per_request
 *   3. user    monthly_allowance
 *   4. account monthly_allowance
 * Per-request violations come first because they can never succeed by waiting or retrying,
 * which is the most useful thing for a caller to learn. Within a tier the user is checked first.
 *
 * A rejection consumes nothing, so `*RemainingAfter` then equals the remaining before.
 */
export function evaluate({ units, account, user }: EvaluationInput): Decision {
  if (!Number.isSafeInteger(units) || units <= 0) {
    throw new RangeError('units must be a positive whole number');
  }

  let rejection: Rejection | null = null;
  if (exceedsPerRequest(units, user.limits)) rejection = reject('user', 'max_per_request');
  else if (exceedsPerRequest(units, account.limits)) rejection = reject('account', 'max_per_request');
  else if (exceedsAllowance(units, user)) rejection = reject('user', 'monthly_allowance');
  else if (exceedsAllowance(units, account)) rejection = reject('account', 'monthly_allowance');

  const accepted = rejection === null;
  const taken = accepted ? units : 0;

  return {
    accepted,
    rejection,
    accountRemainingAfter: remainingAllowance(account.limits, account.consumed + taken),
    userRemainingAfter: remainingAllowance(user.limits, user.consumed + taken),
  };
}