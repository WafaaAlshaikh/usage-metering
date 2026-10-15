import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { Config } from './config';
import type { Db } from './db/client';
import { registerErrorHandler } from './http/errorHandler';
import { registerRoutes } from './http/routes/index';

export interface AppDeps {
  db: Db;
  config: Config;
}

export function buildApp({ db, config }: AppDeps): FastifyInstance {
  const app = Fastify({ logger: config.LOG_LEVEL === 'silent' ? false : { level: config.LOG_LEVEL } });

  app.decorateRequest('account', null);
  registerErrorHandler(app);

  app.get('/health', async () => {
    await db.execute(sql`select 1`);
    return { status: 'ok' };
  });

  registerRoutes(app, { db, config });

  return app;
}