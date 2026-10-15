import { z } from 'zod';
import { pageLimit, periodQuery } from './common';

export const historyQuery = z.object({
  userId: z.string().min(1).max(255).optional(),
  period: periodQuery.optional(),
  accepted: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  limit: pageLimit,
  cursor: z.string().min(1).max(500).optional(),
});