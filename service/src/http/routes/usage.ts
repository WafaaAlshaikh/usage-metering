import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/client';
import { periodLabel, periodStartOf } from '../../domain/period';
import { getUsage } from '../../services/usage';
import { usageQuery } from '../schemas/usage';
import { planView } from '../views';

export function usageRoutes(app: FastifyInstance, deps: { db: Db }): void {
  app.get('/usage', async (req) => {
    const q = usageQuery.parse(req.query);
    const periodStart = q.period ?? periodStartOf(new Date());
    const r = await getUsage(deps.db, req.account!, { periodStart, limit: q.limit, after: q.after });
    return {
      period: periodLabel(periodStart),
      account: { plan: planView(r.account.plan), consumed: r.account.consumed, remaining: r.account.remaining },
      users: r.users.map((u) => ({
        userId: u.externalId,
        deleted: u.deleted,
        plan: planView(u.plan),
        consumed: u.consumed,
        remaining: u.remaining,
      })),
      nextCursor: r.nextCursor,
    };
  });
}