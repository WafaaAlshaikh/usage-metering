import { z } from 'zod';
import { BadRequestError } from './errors';

// created_at is kept as the TEXT Postgres prints (microsecond precision). A JS Date only has
// milliseconds, so going through Date could skip or repeat rows at a page boundary.
const TIMESTAMPTZ_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

const cursorShape = z.object({ t: z.string().regex(TIMESTAMPTZ_TEXT), id: z.string().uuid() });
export type HistoryCursor = z.infer<typeof cursorShape>;

export const encodeCursor = (c: HistoryCursor): string => Buffer.from(JSON.stringify(c)).toString('base64url');

/** Anything that is not a cursor we produced is a 400 (never reaches SQL). */
export function decodeCursor(raw: string): HistoryCursor {
  try {
    return cursorShape.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    throw new BadRequestError('Invalid cursor');
  }
}