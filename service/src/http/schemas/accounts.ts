import { z } from 'zod';

export const createAccountBody = z.object({
  name: z.string().trim().min(1).max(200),
  planName: z.string().trim().min(1).max(100).optional(),
});