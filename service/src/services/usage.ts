import type { Db } from '../db/client';
import type { Account, Plan } from '../db/schema';
import type { Limits } from '../domain/decision';
import { remainingAllowance } from '../domain/rules';
import { findPlanById } from '../repo/plans';
import { getAccountConsumed, listUserUsage } from '../repo/usageQueries';

const limitsOf = (p: Plan): Limits => ({
  monthlyAllowance: p.monthlyAllowance,
  maxUnitsPerRequest: p.maxUnitsPerRequest,
});

export interface UsageInput {
  periodStart: string;
  limit: number;
  after?: string | undefined;
}

export async function getUsage(db: Db, account: Account, input: UsageInput) {
  return db.transaction(
    async (tx) => {
      const accountPlan = await findPlanById(tx, account.accountPlanId);
      if (!accountPlan) throw new Error('account plan could not be loaded');

      const accountConsumed = await getAccountConsumed(tx, account.id, input.periodStart);
      const rows = await listUserUsage(tx, account.id, input.periodStart, input.limit, input.after);
      const page = rows.slice(0, input.limit);

      return {
        account: {
          plan: accountPlan,
          consumed: accountConsumed,
          remaining: remainingAllowance(limitsOf(accountPlan), accountConsumed),
        },
        users: page.map((r) => {
          const consumed = r.consumed ?? 0;
          return {
            externalId: r.user.externalId,
            deleted: r.user.deletedAt !== null,
            plan: r.plan,
            consumed,
            remaining: remainingAllowance(limitsOf(r.plan), consumed),
          };
        }),
        nextCursor: rows.length > input.limit ? page[page.length - 1]!.user.externalId : null,
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}