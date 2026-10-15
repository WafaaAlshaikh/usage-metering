import type { Account, Plan, User } from '../db/schema';

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