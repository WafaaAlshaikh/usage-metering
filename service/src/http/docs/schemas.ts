import { z } from 'zod';
import type { OpenAPIV3 } from 'openapi-types';

/** Documentation only: never installed as Fastify validators or serializers. */
export function schemaOf(value: z.ZodType): OpenAPIV3.SchemaObject {
  return z.toJSONSchema(value, { target: 'openapi-3.0', io: 'input' }) as OpenAPIV3.SchemaObject;
}

const id = z.string().uuid();
const timestamp = z.string().datetime();
const count = z.number().int().nonnegative();
const remaining = count.nullable();
const limits = z.object({
  monthlyAllowance: remaining,
  maxUnitsPerRequest: remaining,
});
const plan = z.object({
  id, kind: z.enum(['account', 'user']), name: z.string(),
  monthlyAllowance: remaining, maxUnitsPerRequest: remaining,
  isPredefined: z.boolean(), archived: z.boolean(),
  createdAt: timestamp, updatedAt: timestamp,
});
const user = z.object({ userId: z.string(), plan, createdAt: timestamp });
const account = z.object({
  id, name: z.string(), apiKeyPrefix: z.string(), plan, createdAt: timestamp,
});
const scope = z.object({ planId: id, limits, remaining });
const outcome = z.object({
  requestId: z.string(), userId: z.string(), units: z.number().int().positive(),
  accepted: z.boolean(), period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  rejection: z.object({
    scope: z.enum(['account', 'user']),
    rule: z.enum(['max_per_request', 'monthly_allowance']),
  }).nullable(),
  account: scope, user: scope,
});
const usageScope = z.object({ plan, consumed: count, remaining });

export const responseSchemas: Record<string, OpenAPIV3.SchemaObject> = Object.fromEntries(
  Object.entries({
    Error: z.object({
      error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
    }),
    Health: z.object({ status: z.literal('ok') }),
    Plan: plan,
    Plans: z.object({ plans: z.array(plan) }),
    Account: account,
    CreatedAccount: z.object({
      id, name: z.string(), apiKeyPrefix: z.string(), planId: id,
      createdAt: timestamp, apiKey: z.string(),
    }),
    User: user,
    RegisteredUser: z.object({
      userId: z.string(), planId: id, createdAt: timestamp, reactivated: z.boolean(),
    }),
    Users: z.object({ users: z.array(user), nextCursor: z.string().nullable() }),
    Consume: outcome.extend({ replayed: z.boolean() }),
    History: z.object({
      requests: z.array(outcome.extend({ createdAt: timestamp })),
      nextCursor: z.string().nullable(),
    }),
    Usage: z.object({
      period: z.string(),
      account: usageScope,
      users: z.array(usageScope.extend({ userId: z.string(), deleted: z.boolean() })),
      nextCursor: z.string().nullable(),
    }),
  }).map(([name, value]) => [name, schemaOf(value)]),
);

const exampleScope = (planId: string, monthlyAllowance: number, maxUnitsPerRequest: number, left: number) => ({
  planId, limits: { monthlyAllowance, maxUnitsPerRequest }, remaining: left,
});
const baseOutcome = {
  requestId: 'doc-8841', userId: 'alice', units: 10,
  period: '2026-10',
  account: exampleScope('11111111-1111-4111-8111-111111111111', 10000, 100, 9990),
  user: exampleScope('22222222-2222-4222-8222-222222222222', 1000, 20, 990),
};
export const consumeExamples: Record<string, OpenAPIV3.ExampleObject> = {
  accepted: {
    summary: 'Accepted: both counters increment',
    value: { ...baseOutcome, accepted: true, replayed: false, rejection: null },
  },
  rejected: {
    summary: 'Rejected by the user per-request limit; HTTP 200, no units consumed',
    value: {
      ...baseOutcome, requestId: 'doc-8842', units: 25, accepted: false, replayed: false,
      rejection: { scope: 'user', rule: 'max_per_request' },
    },
  },
  replayed: {
    summary: 'Retry: original result, no additional consumption',
    value: { ...baseOutcome, accepted: true, replayed: true, rejection: null },
  },
};
