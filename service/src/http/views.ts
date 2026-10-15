import type { Account, Plan, RequestLogRow, User } from '../db/schema';
import { periodLabel } from '../domain/period';

export const planView = (p: Plan) => ({
  id: p.id,
  kind: p.kind,
  name: p.name,
  monthlyAllowance: p.monthlyAllowance, // null = no limit
  maxUnitsPerRequest: p.maxUnitsPerRequest, // null = no limit
  isPredefined: p.isPredefined,
  archived: p.archivedAt !== null,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

export const userView = (u: User, plan: Plan) => ({
  userId: u.externalId,
  plan: planView(plan),
  createdAt: u.createdAt,
});

export const accountView = (a: Account, plan: Plan) => ({
  id: a.id,
  name: a.name,
  apiKeyPrefix: a.apiKeyPrefix,
  plan: planView(plan),
  createdAt: a.createdAt,
});

/** Same shape as the consume response, so a client can reuse its types. */
export const historyView = (r: RequestLogRow, externalUserId: string) => ({
  requestId: r.requestId,
  userId: externalUserId,
  units: r.units,
  accepted: r.accepted,
  rejection: r.accepted ? null : { scope: r.rejectedBy, rule: r.rejectedRule },
  period: periodLabel(r.periodStart),
  account: {
    planId: r.accountPlanId,
    limits: { monthlyAllowance: r.accountMonthlyAllowance, maxUnitsPerRequest: r.accountMaxPerRequest },
    remaining: r.accountRemainingAfter,
  },
  user: {
    planId: r.userPlanId,
    limits: { monthlyAllowance: r.userMonthlyAllowance, maxUnitsPerRequest: r.userMaxPerRequest },
    remaining: r.userRemainingAfter,
  },
  createdAt: r.createdAt,
});