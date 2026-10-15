import { z } from 'zod';
import { pageLimit, periodQuery } from './common';

export const usageQuery = z.object({
  period: periodQuery.optional(),
  limit: pageLimit,
  after: z.string().min(1).max(255).optional(), // last userId of the previous page
});