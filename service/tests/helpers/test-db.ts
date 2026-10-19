import { Pool, type PoolClient } from 'pg';
import { createDb, type Db } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { seedPredefinedPlans } from '../../src/db/seed';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://metering:metering@localhost:5434/metering_test';

export interface TestDb {
  db: Db;
  pool: Pool;
  close: () => Promise<void>;
}


export async function setupTestDb(): Promise<TestDb> {
  const dbName = new URL(TEST_DATABASE_URL).pathname.slice(1);
  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to wipe "${dbName}": test database names must end in "_test"`);
  }
    const { db, pool } = createDb(TEST_DATABASE_URL, {
    max: 10,
    // Tests fire hundreds of requests at once on a small pool; queueing is expected, not overload.
    connectionTimeoutMs: 60_000,
    lockTimeoutMs: 60_000,
    statementTimeoutMs: 60_000,
  });
  await pool.query('drop schema if exists public cascade');
  await pool.query('drop schema if exists drizzle cascade');
  await pool.query('create schema public');
  await runMigrations(db);
  await seedPredefinedPlans(db);
  return { db, pool, close: () => pool.end() };
}

export async function attempt(client: PoolClient, text: string, params: unknown[] = []) {
  await client.query('savepoint attempt');
  try {
    const result = await client.query(text, params);
    await client.query('release savepoint attempt');
    return result;
  } catch (err) {
    await client.query('rollback to savepoint attempt');
    throw err;
  }
}