import { z } from 'zod';

export const consumeBody = z.object({
  userId: z.string().trim().min(1).max(255),
  requestId: z.string().trim().min(1).max(255),
  // Exact up to 2^53; the cap keeps counters far below that.
  units: z.number().int().positive().max(1_000_000_000_000),
});