import { and, desc, eq, sql } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { requestLog, users } from '../db/schema';

export async function findByRequestId(ex: Executor, accountId: string, requestId: string) {
  const [row] = await ex
    .select()
    .from(requestLog)
    .where(and(eq(requestLog.accountId, accountId), eq(requestLog.requestId, requestId)))
    .limit(1);
  return row ?? null;
}

export async function insertRequestLog(ex: Executor, row: typeof requestLog.$inferInsert): Promise<void> {
  // clock_timestamp(), not now(): now() is the transaction START (before waiting for the lock),
  // so history order could differ from decision order under contention.
  await ex.insert(requestLog).values({ ...row, createdAt: sql`clock_timestamp()` });
}

export interface HistoryFilter {
  accountId: string;
  userId?: string | undefined; // internal id
  periodStart?: string | undefined;
  accepted?: boolean | undefined;
  before?: { t: string; id: string } | undefined;
  limit: number;
}

/** Newest first. Keyset pagination on (created_at, id), served by request_log_*_created_idx. */
export async function listRequestLog(ex: Executor, f: HistoryFilter) {
  return ex
    .select({
      row: requestLog,
      createdAtText: sql<string>`${requestLog.createdAt}::text`,
      externalId: users.externalId,
    })
    .from(requestLog)
    .innerJoin(users, eq(users.id, requestLog.userId))
    .where(
      and(
        eq(requestLog.accountId, f.accountId),
        f.userId === undefined ? undefined : eq(requestLog.userId, f.userId),
        f.periodStart === undefined ? undefined : eq(requestLog.periodStart, f.periodStart),
        f.accepted === undefined ? undefined : eq(requestLog.accepted, f.accepted),
        f.before === undefined
          ? undefined
          : sql`(${requestLog.createdAt}, ${requestLog.id}) < (${f.before.t}::timestamptz, ${f.before.id}::uuid)`,
      ),
    )
    .orderBy(desc(requestLog.createdAt), desc(requestLog.id))
    .limit(f.limit + 1);
}