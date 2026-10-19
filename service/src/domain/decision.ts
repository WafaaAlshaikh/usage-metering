export type Scope = 'account' | 'user';
export type RuleType = 'max_per_request' | 'monthly_allowance';

export interface Limits {
  monthlyAllowance: number | null;
  maxUnitsPerRequest: number | null;
}

export interface Rejection {
  scope: Scope;
  rule: RuleType;
}

export interface Decision {
  accepted: boolean;
  rejection: Rejection | null;
  accountRemainingAfter: number | null;
  userRemainingAfter: number | null;
}