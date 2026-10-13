import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { runMigrations } from './db/migrate';
import { seedPredefinedPlans } from './db/seed';

async function main() {
  const config = loadConfig();
  const { db, pool } = createDb(config.DATABASE_URL, config.DB_POOL_MAX);

  await runMigrations(db);
  await seedPredefinedPlans(db);

  const app = buildApp({ db, config });
  await app.listen({ port: config.PORT, host: '0.0.0.0' });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});