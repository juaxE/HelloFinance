/**
 * `npm run seed:test` (CLAUDE.md validation §3): loads the synthetic
 * fixtures into `data/dev.db` with known totals so the dev app has real-looking
 * data to look at, and integration checks can assert against
 * `fixtures/expected.json`. Real data never enters development (CLAUDE.md
 * non-negotiable #5).
 *
 * The path is `DEV_DATABASE_PATH`, hard-wired: this script never reads
 * `FINANCE_MODE`, because what it writes is synthetic by construction and there
 * is no mode under which it should target the real database (proposal 005).
 *
 * Seeds:
 *  - Main + Buffer accounts, opening balance 0 on 2025-07-01 (before every
 *    fixture row, so nothing is before-opening-excluded).
 *  - The main + buffer fixture CSVs, imported and committed in full
 *    (allowUncategorized) — a year of real-looking committed history.
 *  - Two labeling rules, so the Rules screen and "from rule" badges have
 *    something to show.
 *  - Recurring templates, and the assets + monthly snapshots the dashboard's
 *    net-worth trend reads (spec 004). Both live in `seed-data.ts` so tests can
 *    build the same state in memory.
 *  - The overlap fixture, imported but left `pending_review` into Main — a
 *    live review screen (28 duplicates, 14 new groups) for manual QA and the
 *    Playwright review-screen spec (AC 002-12), without scripting a browser
 *    file upload.
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_DATABASE_PATH } from '../config';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import { accounts } from '../db/schema';
import { analyzeImport, commitImport } from '../import/pipeline';
import { FIXTURE_EXPECTATIONS as expected, seedAssets, seedRule, seedTemplates } from './seed-data';
import { assertSeedableDatabase, markSyntheticSeed } from '../db/marker';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = resolve(HERE, '../../../../fixtures');

function resetDatabaseFile(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = path + suffix;
    if (existsSync(p)) unlinkSync(p);
  }
}

function loadFixture(relPath: string): Buffer {
  return readFileSync(resolve(FIXTURES_ROOT, relPath));
}

function main(): void {
  // Only a DB this script itself created may be overwritten — the real DB has
  // no marker and makes this throw (audit B2; see db/marker.ts).
  assertSeedableDatabase(DEV_DATABASE_PATH);
  resetDatabaseFile(DEV_DATABASE_PATH);
  const db = createDb(DEV_DATABASE_PATH);
  try {
    runMigrations(db);
    markSyntheticSeed(db);
  } catch (err) {
    // Failing here would strand an unmarked dev.db that this script just
    // created: the dev server would then refuse it as "may hold real data" and
    // seed:test would refuse to overwrite it, a deadlock clearable only by
    // hand. The file is ours and pre-seed, so take it back out.
    db.$client.close();
    resetDatabaseFile(DEV_DATABASE_PATH);
    throw err;
  }

  const mainAccount = db
    .insert(accounts)
    .values({ name: 'Main', kind: 'main', openingBalanceDate: '2025-07-01', openingBalanceCents: 0 })
    .returning()
    .get();
  const bufferAccount = db
    .insert(accounts)
    .values({
      name: 'Buffer',
      kind: 'buffer',
      openingBalanceDate: '2025-07-01',
      openingBalanceCents: 0,
    })
    .returning()
    .get();

  // Rules must exist BEFORE analyzeImport: the pipeline reads `labeling_rules`
  // once, at analyze time, and freezes each row's `proposed_category_id` into
  // staging; commit only reads `chosen ?? proposed`. Seeded after the import,
  // these rows would still show up on the Rules screen while having labelled
  // nothing — a demonstration of the rule engine that quietly demonstrates
  // nothing. Both targets are EXPENSE categories on purpose: `generate.mjs`
  // computes the spec 003 M-definition from type hints as a proxy for the
  // category rule, which stays faithful only while no seeded rule assigns an
  // income-source category.
  seedRule(db, 'K-MARKET', 'Groceries', 'K-Market Kamppi 4021');
  seedRule(db, 'NETFLIX.COM', 'Subscriptions', 'NETFLIX.COM');

  const mainBytes = loadFixture(expected.files.main!.path);
  const mainImport = analyzeImport(db, {
    accountId: mainAccount.id,
    filename: 'main-2025-07_2026-06.csv',
    bytes: mainBytes,
  });
  const mainCommit = commitImport(db, mainImport.importId, { allowUncategorized: true });

  const bufferBytes = loadFixture(expected.files.buffer!.path);
  const bufferImport = analyzeImport(db, {
    accountId: bufferAccount.id,
    filename: 'buffer-2025-07_2026-06.csv',
    bytes: bufferBytes,
  });
  const bufferCommit = commitImport(db, bufferImport.importId, { allowUncategorized: true });

  seedTemplates(db);
  seedAssets(db);

  const overlapBytes = loadFixture(expected.files.overlap!.path);
  const overlapImport = analyzeImport(db, {
    accountId: mainAccount.id,
    filename: 'overlap-2026-06_2026-07.csv',
    bytes: overlapBytes,
  });

  console.log(
    [
      `Seeded ${DEV_DATABASE_PATH}`,
      `  Main account #${mainAccount.id}: ${mainCommit.inserted} committed (${mainCommit.uncategorized} uncategorized)`,
      `  Buffer account #${bufferAccount.id}: ${bufferCommit.inserted} committed (${bufferCommit.uncategorized} uncategorized)`,
      `  2 labeling rules seeded (K-MARKET -> Groceries, NETFLIX.COM -> Subscriptions)`,
      `  5 recurring templates seeded (monthly/quarterly/yearly bills; no envelopes — those are the owner's to set)`,
      `  ${expected.assets.seeded.length} assets seeded with monthly snapshots (each skipping one month, for carry-forward)`,
      `  Pending review import #${overlapImport.importId} on Main (overlap file: 28 duplicates, 14 new groups expected)`,
    ].join('\n'),
  );
}

main();
