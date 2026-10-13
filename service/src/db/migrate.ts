import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Db } from './client';

// Works from both src/db (tsx) and dist/db (Docker): ../../drizzle is service/drizzle.
const MIGRATIONS_FOLDER = path.resolve(__dirname, '../../drizzle');

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}