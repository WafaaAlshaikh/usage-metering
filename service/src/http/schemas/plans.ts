import { z } from 'zod';

const MAX = 1_000_000_000_000;
const allowance = z.number().int().min(0).max(MAX).nullable(); // null = unlimited
const perRequest = z.number().int().positive().max(MAX).nullable();

export const createPlanBody = z.object({
  kind: z.enum(['account', 'user']),
  name: z.string().trim().min(1).max(100),
  monthlyAllowance: allowance.default(null),
  maxUnitsPerRequest: perRequest.default(null),
});

/** Missing field = unchanged; null = remove that limit. */
export const patchPlanBody = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    monthlyAllowance: allowance.optional(),
    maxUnitsPerRequest: perRequest.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Provide at least one field to change' });

export const planIdParams = z.object({ id: z.string().uuid() });

export const listPlansQuery = z.object({
  kind: z.enum(['account', 'user']).optional(),
  includeArchived: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export const assignPlanBody = z.object({ planId: z.string().uuid() });