import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Db } from './client';

/**
 * Apply all pending Drizzle migrations (schema + category seed) to `db`.
 *
 * Drizzle tracks applied migrations in `__drizzle_migrations`, so this is
 * idempotent: running it against an already-migrated database is a no-op
 * (acceptance criterion 001-1). Used both at server startup and by tests, which
 * pass an in-memory database.
 */
const MIGRATIONS_FOLDER = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
