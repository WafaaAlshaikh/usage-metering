import { and, eq } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { requestLog } from '../db/schema';

export async function findByRequestId(ex: Executor, accountId: string, requestId: string) {
  const [row] = await ex
    .select()
    .from(requestLog)
    .where(and(eq(requestLog.accountId, accountId), eq(requestLog.requestId, requestId)))
    .limit(1);
  return row ?? null;
}

export async function insertRequestLog(ex: Executor, row: typeof requestLog.$inferInsert): Promise<void> {
  await ex.insert(requestLog).values(row);
}