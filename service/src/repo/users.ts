import { and, eq } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { users } from '../db/schema';

/** Looks the user up inside the calling account only, so another account's users are invisible. */
export async function findUserByExternalId(ex: Executor, accountId: string, externalId: string) {
  const [row] = await ex
    .select()
    .from(users)
    .where(and(eq(users.accountId, accountId), eq(users.externalId, externalId)))
    .limit(1);
  return row ?? null;
}