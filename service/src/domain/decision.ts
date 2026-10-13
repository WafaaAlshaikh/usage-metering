export type Scope = 'account' | 'user';
export type RuleType = 'max_per_request' | 'monthly_allowance';

/** The rules of one plan. `null` means "no limit for this rule". */
export interface Limits {
  monthlyAllowance: number | null;
  maxUnitsPerRequest: number | null;
}

/** Which side (account or user) and which rule blocked a request. */
export interface Rejection {
  scope: Scope;
  rule: RuleType;
}

export interface Decision {
  accepted: boolean;
  /** Set only when `accepted` is false. */
  rejection: Rejection | null;
  /** Monthly allowance left right after this decision (`null` = unlimited). */
  accountRemainingAfter: number | null;
  userRemainingAfter: number | null;
}