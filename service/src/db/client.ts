import { drizzle, type NodePgDatabase, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;

/** What repository functions accept: the database itself or a transaction on it. */
export type Executor = PgDatabase<NodePgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  pool: Pool;
}

export function createDb(connectionString: string, max = 20): DbHandle {
  const pool = new Pool({ connectionString, max });
  const db = drizzle(pool, { schema });
  return { db, pool };
}