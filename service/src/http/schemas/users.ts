import { z } from 'zod';

export const createUserBody = z.object({
  externalId: z.string().trim().min(1).max(255),
  planId: z.string().uuid().optional(),
});

export const userParams = z.object({ externalId: z.string().min(1).max(255) });

export const listUsersQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  after: z.string().min(1).max(255).optional(),
});