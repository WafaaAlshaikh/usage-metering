import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  pool: Pool;
}

export function createDb(connectionString: string, max = 20): DbHandle {
  const pool = new Pool({ connectionString, max });
  const db = drizzle(pool, { schema });
  return { db, pool };
}