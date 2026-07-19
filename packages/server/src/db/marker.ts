import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { Db } from './client';

/**
 * The `_synthetic_seed` marker: the one bit that distinguishes a disposable
 * synthetic database from one that may hold real money data. It has two
 * readers, which is why it lives under `db/` rather than with the seed script —
 * server startup depends on it:
 *
 *  - `db/mode-guard.ts` checks it in both directions on every server start.
 *  - `scripts/seed-test.ts` refuses to overwrite a database without it
 *    (audit item B2).
 *
 * Deliberately no `--force` escape hatch: if an unmarked DB really is
 * disposable, deleting the file by hand is the explicit act that says so.
 */

export const MARKER_TABLE = '_synthetic_seed';

/**
 * Does the database at `path` carry the synthetic marker? Answers for an
 * existing file only — callers decide what a missing file means (the seed
 * script may create one; the mode guard treats a fresh dev path as blank).
 *
 * Read-only, and the single place the marker table name is queried: the mode
 * guard (`db/mode-guard.ts`) reads it in both directions.
 */
export function hasSyntheticMarker(path: string): boolean {
  let sqlite: Database.Database;
  try {
    sqlite = new Database(path, { readonly: true, fileMustExist: true });
  } catch (cause) {
    // This now runs on every server start, not just `seed:test`, so an opaque
    // sqlite error here reads as "the mode guard is broken". The usual cause is
    // a hot `-wal` left by a killed process, which a readonly open cannot
    // recover.
    //
    // The remediation is deliberately non-destructive. This branch is reached
    // precisely when the database CANNOT be identified, so it may be the real
    // one — and an uncheckpointed `-wal` holds committed transactions that
    // deleting it would silently discard (see README, "Backing up").
    throw new Error(
      `cannot read ${path} to check for the ${MARKER_TABLE} marker: ${(cause as Error).message}. ` +
        'This is usually a -wal left hot by a killed server, which a read-only open cannot ' +
        'recover. Stop any process still holding the database, then re-run — do not delete the ' +
        '-wal file, it may hold committed transactions. The guard refuses to proceed while it ' +
        'cannot tell real data from the synthetic seed.',
      { cause },
    );
  }
  try {
    return (
      sqlite
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(MARKER_TABLE) !== undefined
    );
  } finally {
    sqlite.close();
  }
}

export function assertSeedableDatabase(path: string): void {
  if (path === ':memory:' || !existsSync(path)) return;

  if (!hasSyntheticMarker(path)) {
    throw new Error(
      `refusing to overwrite ${path}: it was not created by seed:test ` +
        `(no ${MARKER_TABLE} marker), so it may hold real data. ` +
        'If it is genuinely disposable, delete the file yourself and re-run.',
    );
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
