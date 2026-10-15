import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import type { Db } from '../../db/client';
import { registerAccount } from '../../services/accounts';
import { createAccountBody } from '../schemas/accounts';

// Public (admin-token protected when configured): creating an account is how you get a key.
export function accountsPublicRoutes(
  app: FastifyInstance,
  deps: { db: Db; adminAuth: (req: any) => Promise<void> },
): void {
  app.post('/accounts', { preHandler: deps.adminAuth }, async (req, reply) => {
    const body = createAccountBody.parse(req.body);
    const account = await registerAccount(deps.db, body);
    return reply.status(201).send(account);
  });
}