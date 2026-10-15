import { z } from 'zod';
import { parsePeriod } from '../../domain/period';

/** 'YYYY-MM' in, 'YYYY-MM-01' (what the database stores) out. */
export const periodQuery = z
  .string()
  .refine((v) => parsePeriod(v) !== null, { message: 'period must look like YYYY-MM, e.g. 2026-10' })
  .transform((v) => parsePeriod(v)!);

export const pageLimit = z.coerce.number().int().min(1).max(200).default(50);