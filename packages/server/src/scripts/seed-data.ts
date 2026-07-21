/**
 * The non-CSV half of the fixture seed: recurring templates (spec 003) and
 * manual assets + snapshots (spec 004).
 *
 * Extracted from `seed-test.ts` so integration tests can build the SAME seeded
 * state in an in-memory database without importing that script (which resets and
 * writes `data/app.db` at import time). `seed-test.ts` is now the only caller
 * that touches a real file.
 *
 * Assets and their snapshots come from `fixtures/expected.json`, which is where
 * the net-worth expectations are computed from the same numbers — so a test
 * asserting net worth against the fixture file cannot drift from what was seeded.
 * Templates are declared here and mirrored (with a guarding test) in
 * `fixtures/generate.mjs`; see the comment on `SEEDED_TEMPLATES` there.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { assetSnapshots, assets, categories, labelingRules, recurringTemplates } from '../db/schema';

const FIXTURES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures');

type SeededAsset = {
  name: string;
  kind: 'investment' | 'loan' | 'other';
  gapMonth: string;
  snapshots: Record<string, number>;
};

/** `fixtures/expected.json` — only the fields the seed reads are typed. */
export const FIXTURE_EXPECTATIONS = JSON.parse(
  readFileSync(resolve(FIXTURES_ROOT, 'expected.json'), 'utf-8'),
) as {
  files: Record<string, { path: string }>;
  assets: { seeded: SeededAsset[]; openingBalanceDate: string };
  netWorth: {
    byMonth: Record<
      string,
      { accountsCents: number; investmentsCents: number; loansCents: number; netWorthCents: number }
    >;
  };
  recurringCommitments: {
    normalizedMonthlyCents: number;
    byTemplate: { name: string; amountCents: number; intervalMonths: number; monthlyEquivalentCents: number }[];
  };
};

/**
 * Recurring templates matched to counterparties the fixtures actually charge,
 * across all three cadences, so the Budgets screen has a real bill plan to
 * reconcile (spec 003). No envelope is ever derived from a template: an envelope
 * exists only because the owner set it, or the "did I budget this month?" signal
 * would be a lie (decision 003-K). `seed-test.ts` plants envelopes in two closed
 * months by hand, standing in for months the owner budgeted while they were
 * current — that path is not shared with `test/helpers.ts`, see both sites.
 *
 * `[name, category, cents/occurrence, intervalMonths, day, startMonth, matchKey]`.
 */
export const SEEDED_TEMPLATES = [
  ['Rent', 'Housing', 118000, 1, 5, '2025-07', 'ASUNTO OY HELSINGIN ESIMERKKI'],
  ['Gym', 'Health', 4990, 1, 3, '2025-07', 'ELIXIA HELSINKI'],
  ['Netflix', 'Subscriptions', 1799, 1, 12, '2025-07', 'NETFLIX.COM'],
  ['Self storage', 'Other', 8700, 3, 20, '2025-07', 'PELICAN SELF STORAGE'],
  ['Home insurance', 'Other', 60000, 12, 15, '2025-10', 'LÄHITAPIOLA'],
] as const;

export function seedTemplates(db: Db): void {
  for (const [name, categoryName, amountCents, intervalMonths, day, startMonth, key] of SEEDED_TEMPLATES) {
    db.insert(recurringTemplates)
      .values({
        name,
        categoryId: requireCategory(db, categoryName),
        amountCents,
        intervalMonths,
        expectedDayOfMonth: day,
        startMonth,
        matchNormalizedCounterparty: key,
      })
      .run();
  }
}

/**
 * Assets plus their monthly snapshots. Each series skips its `gapMonth`, so the
 * seeded data exercises carry-forward (decision 004-B) rather than only the
 * every-month-entered happy path.
 */
export function seedAssets(db: Db): void {
  for (const seeded of FIXTURE_EXPECTATIONS.assets.seeded) {
    const asset = db.insert(assets).values({ name: seeded.name, kind: seeded.kind }).returning().get();
    for (const month of Object.keys(seeded.snapshots).sort()) {
      db.insert(assetSnapshots)
        .values({ assetId: asset.id, month, valueCents: seeded.snapshots[month]! })
        .run();
    }
  }
}

export function seedRule(db: Db, normalized: string, categoryName: string, exampleRaw: string): void {
  db.insert(labelingRules)
    .values({
      normalizedCounterparty: normalized,
      categoryId: requireCategory(db, categoryName),
      exampleRaw,
    })
    .run();
}

function requireCategory(db: Db, name: string): number {
  const category = db.select().from(categories).where(eq(categories.name, name)).get();
  if (!category) throw new Error(`category "${name}" not found`);
  return category.id;
}
