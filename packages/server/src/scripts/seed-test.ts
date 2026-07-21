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
 *  - Two historical budget months (2026-04, 2026-05) with envelopes, planned as
 *    if they had been budgeted while current — closed months take no writes
 *    (proposal 007), so this is the only way the browser tests can see one.
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
import { eq } from 'drizzle-orm';
import { accounts, budgetLines, categories } from '../db/schema';
import { materializeMonth } from '../budgets/materialize';
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

/**
 * Two months the owner budgeted **while they were current**: 2026-04 and
 * 2026-05, relative to the `FINANCE_NOW=2026-06-15` the e2e suite pins. Closed
 * months can no longer be created or given envelopes through any endpoint
 * (proposal 007), so history a browser test needs has to arrive with the seed —
 * and `materializeMonth` is called with the month as its own current month,
 * which is exactly what happened back then.
 *
 * Deliberately NOT mirrored into `test/helpers.ts:seedFixtureApp`, unlike the
 * labeling rules above: the unit-test baselines model "no budgets yet" (003-K)
 * and several criteria assert against a month with zero envelopes. This is a
 * documented divergence between the two seed paths, not drift.
 *
 * 2026-04 is the reconciliation screenshot's month (it holds the uncategorized
 * VIPPS payback); 2026-05 is the previous month whose envelopes the current
 * month's budget-making screen suggests.
 */
function seedHistoricalBudgets(db: ReturnType<typeof createDb>): void {
  const goalsByMonth: [string, [string, number][]][] = [
    [
      '2026-04',
      [
        ['Groceries', 40000],
        ['Restaurants & Cafés', 15000],
      ],
    ],
    // Transport, not Groceries: the dashboard spec PUTs a Groceries envelope on
    // the current month, and a suggestion is only visibly a suggestion while
    // the month it is suggested into has no envelope of its own.
    ['2026-05', [['Transport', 12000]]],
  ];

  for (const [month, goals] of goalsByMonth) {
    const { budget } = materializeMonth(db, month, month);
    for (const [categoryName, amountCents] of goals) {
      const category = db
        .select()
        .from(categories)
        .where(eq(categories.name, categoryName))
        .get();
      if (!category) throw new Error(`category ${categoryName} not found`);
      db.insert(budgetLines)
        .values({
          budgetId: budget.id,
          kind: 'envelope',
          name: category.name,
          categoryId: category.id,
          amountCents,
        })
        .run();
    }
  }
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
  seedHistoricalBudgets(db);

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
      `  5 recurring templates seeded (monthly/quarterly/yearly bills)`,
      `  2 closed months budgeted (2026-04, 2026-05); every other month has no envelopes — those are the owner's to set`,
      `  ${expected.assets.seeded.length} assets seeded with monthly snapshots (each skipping one month, for carry-forward)`,
      `  Pending review import #${overlapImport.importId} on Main (overlap file: 28 duplicates, 14 new groups expected)`,
    ].join('\n'),
  );
}

main();
