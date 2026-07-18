import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    counterparty: string;
    normalizedCounterparty: string;
    amountCents: number;
    monthExpenseCentsWithRow: number;
    monthExpenseCentsWithoutRow: number;
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
