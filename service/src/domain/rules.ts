import type { Decision, Limits, Rejection, RuleType, Scope } from './decision';

export interface ScopeState {
  limits: Limits;
  consumed: number;
}

export interface EvaluationInput {
  units: number;
  account: ScopeState;
  user: ScopeState;
}

export function remainingAllowance(limits: Limits, consumed: number): number | null {
  if (limits.monthlyAllowance === null) return null;
  return Math.max(0, limits.monthlyAllowance - consumed);
}

const reject = (scope: Scope, rule: RuleType): Rejection => ({ scope, rule });

const exceedsPerRequest = (units: number, limits: Limits): boolean =>
  limits.maxUnitsPerRequest !== null && units > limits.maxUnitsPerRequest;

const exceedsAllowance = (units: number, state: ScopeState): boolean =>
  state.limits.monthlyAllowance !== null && state.consumed + units > state.limits.monthlyAllowance;

//Pure decision: no database, no clock, no side effects.
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