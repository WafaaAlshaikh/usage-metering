import { z } from 'zod';
import { BadRequestError } from './errors';

const TIMESTAMPTZ_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

const cursorShape = z.object({ t: z.string().regex(TIMESTAMPTZ_TEXT), id: z.string().uuid() });
export type HistoryCursor = z.infer<typeof cursorShape>;

export const encodeCursor = (c: HistoryCursor): string => Buffer.from(JSON.stringify(c)).toString('base64url');

export function decodeCursor(raw: string): HistoryCursor {
  try {
    return cursorShape.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    throw new BadRequestError('Invalid cursor');
  }
}