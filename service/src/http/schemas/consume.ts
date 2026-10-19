import { z } from 'zod';

export const consumeBody = z.object({
  userId: z.string().trim().min(1).max(255),
  requestId: z.string().trim().min(1).max(255),
  units: z.number().int().positive().max(1_000_000_000_000),
});