import { createDb, type Db } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';

/**
 * A fresh, fully-migrated in-memory database for a single test. Never touches
 * `data/*.db` (CLAUDE.md validation §2). The category seed migration runs, so
 * the 15 built-in/starter categories are present.
 */
export function createTestDb(): Db {
  const db = createDb(':memory:');
  runMigrations(db);
  return db;
}
