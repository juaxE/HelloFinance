import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, type Db } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { accounts } from '../src/db/schema';
import { analyzeImport, commitImport } from '../src/import/pipeline';
import { seedAssets, seedTemplates } from '../src/scripts/seed-data';

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

const FIXTURES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../fixtures');

type RecurringCase = {
  normalizedCounterparty: string;
  intervalMonths: number;
  amountCentsEach: number;
  months: string[];
  totalCents: number;
};

/**
 * `fixtures/expected.json` — the known-totals contract for the synthetic
 * fixtures (CLAUDE.md validation §3/§5). Only the fields the budget tests read
 * are typed; the file has more.
 */
export const EXPECTED = JSON.parse(
  readFileSync(resolve(FIXTURES_ROOT, 'expected.json'), 'utf-8'),
) as {
  files: Record<string, { path: string }>;
  recurringNonMonthly: { yearly: RecurringCase; quarterly: RecurringCase };
  recurringNegativeCases: {
    absentDueMonth: RecurringCase & { absentMonth: string };
    driftedYearly: RecurringCase & { nominalDueMonth: string; actualMonth: string };
  };
  needsReview: {
    month: string;
    archiveId: string;
    counterparty: string;
    normalizedCounterparty: string;
    amountCents: number;
    monthExpenseCentsWithRow: number;
    monthExpenseCentsWithoutRow: number;
  };
  cashFlowMain: {
    byMonth: Record<
      string,
      {
        incomeCents: number;
        expensesCents: number;
        netCents: number;
        transferExcludedCents: number;
      }
    >;
  };
  incomeSourcesMain: {
    byMonth: Record<string, { salaryCents: number; otherInflowCents: number }>;
  };
  assets: {
    seeded: {
      name: string;
      kind: 'investment' | 'loan' | 'other';
      gapMonth: string;
      snapshots: Record<string, number>;
    }[];
    openingBalanceDate: string;
  };
  netWorth: {
    byMonth: Record<
      string,
      { accountsCents: number; investmentsCents: number; loansCents: number; netWorthCents: number }
    >;
  };
  recurringCommitments: {
    normalizedMonthlyCents: number;
    byTemplate: {
      name: string;
      amountCents: number;
      intervalMonths: number;
      monthlyEquivalentCents: number;
    }[];
  };
};

/** The 12 months the main fixture covers, in order. */
export const FIXTURE_MONTHS = [
  '2025-07',
  '2025-08',
  '2025-09',
  '2025-10',
  '2025-11',
  '2025-12',
  '2026-01',
  '2026-02',
  '2026-03',
  '2026-04',
  '2026-05',
  '2026-06',
];

/** Read a fixture file's bytes by its `expected.json` key (e.g. `main`). */
export function loadFixture(key: string): Buffer {
  const entry = EXPECTED.files[key];
  if (!entry) throw new Error(`fixture "${key}" not found in expected.json`);
  return readFileSync(resolve(FIXTURES_ROOT, entry.path));
}

/**
 * The seed script's state, in memory: Main + Buffer accounts opening at 0 on
 * 2025-07-01, both fixture CSVs committed with `allowUncategorized`, and the
 * recurring templates + assets/snapshots from `seed-data.ts`.
 *
 * Built from the SAME module `seed-test.ts` uses, so a dashboard figure asserted
 * here against `fixtures/expected.json` is asserted against the data the running
 * app actually shows (CLAUDE.md validation §3/§6).
 */
export function seedFixtureApp(db: Db): { mainAccountId: number; bufferAccountId: number } {
  const main = db
    .insert(accounts)
    .values({ name: 'Main', kind: 'main', openingBalanceDate: '2025-07-01', openingBalanceCents: 0 })
    .returning()
    .get();
  const buffer = db
    .insert(accounts)
    .values({
      name: 'Buffer',
      kind: 'buffer',
      openingBalanceDate: '2025-07-01',
      openingBalanceCents: 0,
    })
    .returning()
    .get();

  for (const [accountId, key, filename] of [
    [main.id, 'main', 'main-2025-07_2026-06.csv'],
    [buffer.id, 'buffer', 'buffer-2025-07_2026-06.csv'],
  ] as const) {
    const analyzed = analyzeImport(db, { accountId, filename, bytes: loadFixture(key) });
    commitImport(db, analyzed.importId, { allowUncategorized: true });
  }

  seedTemplates(db);
  seedAssets(db);
  return { mainAccountId: main.id, bufferAccountId: buffer.id };
}
