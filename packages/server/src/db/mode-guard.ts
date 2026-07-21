import { existsSync, rmSync } from 'node:fs';
import type { FinanceMode } from '@finance/shared';
import { createDb, type Db } from './client';
import { runMigrations } from './migrate';
import { hasSyntheticMarker, markSyntheticSeed } from './marker';

/**
 * The mode split (proposal 005). Real finances live in `data/app.db` and the
 * synthetic seed in `data/dev.db`, and the `_synthetic_seed` marker is checked
 * in BOTH directions so the two can never be confused:
 *
 *  - real mode may not open a marked database — that is the seed, and letting
 *    an import land in it means a later `seed:test` deletes real money data
 *    with a clear conscience (the marker survives the import).
 *  - dev mode may not open an unmarked database — nothing says it isn't real.
 *
 * A fresh dev database is marked right after migration, so a DB the dev server
 * created is later overwritable by `seed:test` without hand-deleting it.
 *
 * Guard logic lives here rather than in `index.ts` so it is testable against
 * tempfile SQLite (CLAUDE.md validation §2).
 */

/**
 * `FINANCE_NOW` pins the server's "today" and drives budget materialization and
 * the past-month write lock, not just display — pointed at real finances it
 * would silently reopen genuinely-historical months for writing. CLAUDE.md says
 * it must never be set outside tests; this makes that structural.
 */
export function assertNowOverrideAllowed(mode: FinanceMode, nowOverride: string | null): void {
  if (mode !== 'real' || nowOverride === null) return;
  throw new Error(
    `FINANCE_NOW is set (${nowOverride}) but FINANCE_MODE=real. It pins "today" and controls ` +
      'budget materialization and the past-month write lock, so against your real finances it ' +
      'would reopen historical months for writing. It is a test-only knob: unset it, or run ' +
      '"npm run dev" instead.',
  );
}

/** Both marker directions. No-ops when the file does not exist yet. */
export function assertDatabaseMatchesMode(mode: FinanceMode, path: string): void {
  if (!existsSync(path)) return;
  const marked = hasSyntheticMarker(path);

  if (mode === 'real' && marked) {
    throw new Error(
      `refusing to start in real mode against ${path}: it carries the _synthetic_seed marker, ` +
        'so it is the synthetic seed database, not your finances. Importing real data into it ' +
        `would leave it overwritable by seed:test. Delete ${path} (and its -wal/-shm files) to ` +
        'start a real database, or run "npm run dev" to use the seed.',
    );
  }

  if (mode === 'dev' && !marked) {
    throw new Error(
      `refusing to start in dev mode against ${path}: it has no _synthetic_seed marker, so it ` +
        'was not created by the seed and may hold real data. Move it aside or delete it, then ' +
        're-run — dev mode will create and mark a fresh database.',
    );
  }
}

/**
 * Open, migrate and (in dev, when fresh) mark the database for `mode`.
 * Marking happens after migrations so the marker never lands in a DB that
 * failed to migrate.
 */
export function openDatabaseForMode(mode: FinanceMode, path: string): Db {
  assertDatabaseMatchesMode(mode, path);
  // Computed before `createDb`, which creates the file: afterwards every path
  // looks pre-existing, and `fresh` is the only thing keeping the discard below
  // away from a database that was already there.
  const fresh = !existsSync(path);

  const db = createDb(path);
  try {
    runMigrations(db);
    if (mode === 'dev' && fresh) markSyntheticSeed(db);
  } catch (err) {
    // Both steps are inside: a fresh file that failed to migrate OR failed to
    // get its marker is unmarked either way, so the next dev start would refuse
    // it as "may hold real data" — a lie about a file this process just
    // created, and one only a manual delete could clear. Take it back out.
    if (fresh) discardFreshDatabase(db, path);
    throw err;
  }
  return db;
}

/**
 * Close and unlink a database this call created, WAL siblings included.
 *
 * Only ever reached with `fresh === true`. A pre-existing file is never
 * unlinked on a failure path — it may be the owner's real database, and a
 * failed migration is not a reason to delete it.
 */
function discardFreshDatabase(db: Db, path: string): void {
  db.$client.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
}
