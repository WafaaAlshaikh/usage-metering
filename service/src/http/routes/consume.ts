import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/client';
import { consumeWithRetry } from '../../services/consume';
import { consumeBody } from '../schemas/consume';

export function consumeRoutes(app: FastifyInstance, deps: { db: Db }): void {
  // 200 for both outcomes: the call worked, the decision is in `accepted` (and `rejection`).
  app.post('/consume', async (req) => {
    const body = consumeBody.parse(req.body);
    return consumeWithRetry(deps.db, {
      accountId: req.account!.id,
      externalUserId: body.userId,
      requestId: body.requestId,
      units: body.units,
    });
  });
}