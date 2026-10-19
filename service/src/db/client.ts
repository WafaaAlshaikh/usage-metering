import { drizzle, type NodePgDatabase, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;

export type Executor = PgDatabase<NodePgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  pool: Pool;
}

export interface DbOptions {
  max?: number;
  connectionTimeoutMs?: number;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
}

export function createDb(connectionString: string, opts: DbOptions | number = {}): DbHandle {
  const o: DbOptions = typeof opts === 'number' ? { max: opts } : opts; 
  const pool = new Pool({
    connectionString,
    max: o.max ?? 20,
    // Fail fast instead of queueing forever when the pool or a row lock is saturated.
    connectionTimeoutMillis: o.connectionTimeoutMs ?? 5_000,
    options: `-c lock_timeout=${o.lockTimeoutMs ?? 5_000} -c statement_timeout=${o.statementTimeoutMs ?? 15_000}`,
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

