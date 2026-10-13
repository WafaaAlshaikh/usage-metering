import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { Config } from './config';
import type { Db } from './db/client';

export interface AppDeps {
  db: Db;
  config: Config;
}

export function buildApp({ db, config }: AppDeps): FastifyInstance {
  const app = Fastify({ logger: config.LOG_LEVEL === 'silent' ? false : { level: config.LOG_LEVEL } });

  app.get('/health', async () => {
    await db.execute(sql`select 1`);
    return { status: 'ok' };
  });

  // Routes (accounts, users, plans, consume, usage) are registered here in the next steps.

  return app;
}