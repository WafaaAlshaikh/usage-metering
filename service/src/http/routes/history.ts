import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/client';
import { decodeCursor } from '../../domain/historyCursor';
import { getHistory } from '../../services/history';
import { historyQuery } from '../schemas/history';
import { historyView } from '../views';

export function historyRoutes(app: FastifyInstance, deps: { db: Db }): void {
  // ?userId ?period=YYYY-MM ?accepted=true|false ?limit ?cursor  (newest first)
  app.get('/history', async (req) => {
    const q = historyQuery.parse(req.query);
    const { items, nextCursor } = await getHistory(deps.db, {
      accountId: req.account!.id,
      externalUserId: q.userId,
      periodStart: q.period,
      accepted: q.accepted,
      limit: q.limit,
      before: q.cursor === undefined ? undefined : decodeCursor(q.cursor),
    });
    return { requests: items.map((i) => historyView(i.row, i.externalId)), nextCursor };
  });
}