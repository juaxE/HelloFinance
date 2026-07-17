/**
 * `npm run seed:test` (CLAUDE.md validation §3): loads the synthetic
 * fixtures into `data/app.db` with known totals so the dev app has real data
 * to look at, and integration checks can assert against
 * `fixtures/expected.json`. Real data never enters development (CLAUDE.md
 * non-negotiable #5) — this is the ONLY thing that should ever populate
 * `data/app.db`.
 *
 * Seeds:
 *  - Main + Buffer accounts, opening balance 0 on 2025-07-01 (before every
 *    fixture row, so nothing is before-opening-excluded).
 *  - The main + buffer fixture CSVs, imported and committed in full
 *    (allowUncategorized) — a year of real-looking committed history.
 *  - Two labeling rules, so the Rules screen and "from rule" badges have
 *    something to show.
 *  - The overlap fixture, imported but left `pending_review` into Main — a
 *    live review screen (28 duplicates, 14 new groups) for manual QA and the
 *    Playwright review-screen spec (AC 002-12), without scripting a browser
 *    file upload.
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { DATABASE_PATH } from '../config';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import { accounts, categories, labelingRules } from '../db/schema';
import { analyzeImport, commitImport } from '../import/pipeline';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = resolve(HERE, '../../../../fixtures');
const expected = JSON.parse(readFileSync(resolve(FIXTURES_ROOT, 'expected.json'), 'utf-8')) as {
  files: Record<string, { path: string }>;
};

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
  resetDatabaseFile(DATABASE_PATH);
  const db = createDb(DATABASE_PATH);
  runMigrations(db);

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

  seedRule(db, 'K-MARKET', 'Groceries', 'K-Market Kamppi 4021');
  seedRule(db, 'NETFLIX.COM', 'Subscriptions', 'NETFLIX.COM');

  const overlapBytes = loadFixture(expected.files.overlap!.path);
  const overlapImport = analyzeImport(db, {
    accountId: mainAccount.id,
    filename: 'overlap-2026-06_2026-07.csv',
    bytes: overlapBytes,
  });

  console.log(
    [
      `Seeded ${DATABASE_PATH}`,
      `  Main account #${mainAccount.id}: ${mainCommit.inserted} committed (${mainCommit.uncategorized} uncategorized)`,
      `  Buffer account #${bufferAccount.id}: ${bufferCommit.inserted} committed (${bufferCommit.uncategorized} uncategorized)`,
      `  2 labeling rules seeded (K-MARKET -> Groceries, NETFLIX.COM -> Subscriptions)`,
      `  Pending review import #${overlapImport.importId} on Main (overlap file: 28 duplicates, 14 new groups expected)`,
    ].join('\n'),
  );
}

function seedRule(db: ReturnType<typeof createDb>, normalized: string, categoryName: string, exampleRaw: string): void {
  const category = db.select().from(categories).where(eq(categories.name, categoryName)).get();
  if (!category) throw new Error(`category "${categoryName}" not found`);
  db.insert(labelingRules)
    .values({ normalizedCounterparty: normalized, categoryId: category.id, exampleRaw })
    .run();
}

main();
