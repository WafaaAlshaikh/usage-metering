import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config';
import type { Db } from '../../db/client';
import { consumeWithRetry } from '../../services/consume';
import { registerAccount } from '../../services/accounts';
import { registerUser } from '../../services/users';
import { adminAuth, apiKeyAuth } from '../auth';

const createAccountBody = z.object({
  name: z.string().trim().min(1).max(200),
  planName: z.string().trim().min(1).max(100).optional(),
});

const createUserBody = z.object({
  externalId: z.string().trim().min(1).max(255),
  planId: z.string().uuid().optional(),
});

const consumeBody = z.object({
  userId: z.string().trim().min(1).max(255),
  requestId: z.string().trim().min(1).max(255),
  // Exact up to 2^53; the cap keeps counters far below that.
  units: z.number().int().positive().max(1_000_000_000_000),
});

export function registerRoutes(app: FastifyInstance, deps: { db: Db; config: Config }): void {
  const { db, config } = deps;

  // Public (admin-token protected when configured): creating an account is how you get a key.
  app.post('/accounts', { preHandler: adminAuth(config.ADMIN_TOKEN) }, async (req, reply) => {
    const body = createAccountBody.parse(req.body);
    const account = await registerAccount(db, body);
    return reply.status(201).send(account);
  });

  // Everything below needs a valid API key, which also fixes which account is calling.
  app.register(async (authed) => {
    authed.addHook('preHandler', apiKeyAuth(db));

    authed.post('/users', async (req, reply) => {
      const body = createUserBody.parse(req.body);
      const { user, created } = await registerUser(db, { accountId: req.account!.id, ...body });
      return reply.status(created ? 201 : 200).send({
        userId: user.externalId,
        planId: user.userPlanId,
        createdAt: user.createdAt,
        reactivated: !created,
      });
    });

    // 200 for both outcomes: the call worked, the decision is in `accepted` (and `rejection`).
    authed.post('/consume', async (req) => {
      const body = consumeBody.parse(req.body);
      return consumeWithRetry(db, {
        accountId: req.account!.id,
        externalUserId: body.userId,
        requestId: body.requestId,
        units: body.units,
      });
    });
  });
}