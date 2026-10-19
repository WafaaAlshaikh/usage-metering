import type { Db } from '../db/client';
import { encodeCursor, type HistoryCursor } from '../domain/historyCursor';
import { NotFoundError } from '../domain/errors';
import { listRequestLog } from '../repo/requestLog';
import { findUserByExternalId } from '../repo/users';

export interface HistoryInput {
  accountId: string;
  externalUserId?: string | undefined;
  periodStart?: string | undefined;
  accepted?: boolean | undefined;
  before?: HistoryCursor | undefined;
  limit: number;
}

export async function getHistory(db: Db, input: HistoryInput) {
  let userId: string | undefined;
  if (input.externalUserId !== undefined) {
    const user = await findUserByExternalId(db, input.accountId, input.externalUserId);
    if (!user) throw new NotFoundError(`User "${input.externalUserId}" is not registered for this account`);
    userId = user.id;
  }

  const rows = await listRequestLog(db, {
    accountId: input.accountId,
    userId,
    periodStart: input.periodStart,
    accepted: input.accepted,
    before: input.before,
    limit: input.limit,
  });
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];

  return {
    items: page,
    nextCursor: rows.length > input.limit && last ? encodeCursor({ t: last.createdAtText, id: last.row.id }) : null,
  };
}