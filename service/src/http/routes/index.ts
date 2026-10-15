import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config';
import type { Db } from '../../db/client';
import { adminAuth, apiKeyAuth } from '../auth';
import { accountsPublicRoutes } from './accounts';
import { consumeRoutes } from './consume';
import { usersRoutes } from './users';

export function registerRoutes(app: FastifyInstance, deps: { db: Db; config: Config }): void {
  const { db, config } = deps;

  accountsPublicRoutes(app, { db, adminAuth: adminAuth(config.ADMIN_TOKEN) });

  // Everything below needs a valid API key, which also fixes which account is calling.
  app.register(async (authed) => {
    authed.addHook('preHandler', apiKeyAuth(db));
    usersRoutes(authed, { db });
    consumeRoutes(authed, { db });
  });
}