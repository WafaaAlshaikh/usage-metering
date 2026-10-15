import { z } from 'zod';

export const createUserBody = z.object({
  externalId: z.string().trim().min(1).max(255),
  planId: z.string().uuid().optional(),
});