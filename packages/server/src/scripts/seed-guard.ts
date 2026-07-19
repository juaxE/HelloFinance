import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { Db } from '../db/client';

/**
 * Structural guard against a test run eating real data (audit item B2): the
 * seed script may only overwrite a database it created itself. Every DB
 * written by `seed:test` carries a `_synthetic_seed` marker table; a DB at the
 * target path without that marker — e.g. the real one the dev server created —
 * makes the seed refuse loudly instead of unlinking it.
 *
 * Deliberately no `--force` escape hatch: if an unmarked DB really is
 * disposable, deleting the file by hand is the explicit act that says so.
 */

const MARKER_TABLE = '_synthetic_seed';

export function assertSeedableDatabase(path: string): void {
  if (path === ':memory:' || !existsSync(path)) return;

  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const marker = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(MARKER_TABLE);
    if (!marker) {
      throw new Error(
        `refusing to overwrite ${path}: it was not created by seed:test ` +
          `(no ${MARKER_TABLE} marker), so it may hold real data. ` +
          'If it is genuinely disposable, delete the file yourself and re-run.',
      );
    }
  } finally {
    sqlite.close();
  }
}

/** Stamp a freshly-created seed DB so the next run knows it is synthetic. */
export function markSyntheticSeed(db: Db): void {
  db.$client
    .prepare(
      `CREATE TABLE IF NOT EXISTS ${MARKER_TABLE} (seeded_at TEXT NOT NULL) STRICT`,
    )
    .run();
  db.$client.prepare(`INSERT INTO ${MARKER_TABLE} (seeded_at) VALUES (datetime('now'))`).run();
}
