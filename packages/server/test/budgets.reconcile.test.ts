/**
 * Spec 003 stage 2 — reconciliation against imported transactions.
 *
 * Every test here runs over the real seeded main-account fixture (imported and
 * committed with `allowUncategorized`, as the seed script does), so the numbers
 * are the fixture's own and are asserted against `fixtures/expected.json` where
 * the criterion names it.
 *
 * Criteria covered: 3 (reconciliation half), 6–7, 10–11, 13–14, 16–17, and the
 * computation side of 21–22.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { buildApp } from '../src/app';
import type { Db } from '../src/db/client';
import { accounts, budgetLines, budgets, categories, transactions } from '../src/db/schema';
import { analyzeImport, commitImport } from '../src/import/pipeline';
import { normalizeCounterparty } from '../src/import/normalize';
import { createTestDb, EXPECTED, loadFixture } from './helpers';

let app: FastifyInstance;
let db: Db;

// Pinned to the first fixture month: every month this file opens is the current
// one or a later one, so the past-month write lock (proposal 007) never stands
// between a test and the month it reconciles.
const NOW = new Date('2025-07-15T12:00:00.000Z');

beforeEach(async () => {
  db = createTestDb();
  app = buildApp(db, { now: () => NOW });
  await app.ready();

  // The main fixture, committed with allowUncategorized — the seed script's
  // setup. Only the type hints assign categories (PALKKA -> Income,
  // OMA TILISIIRTO -> Transfer); everything else lands uncategorized, which is
  // exactly the state criterion 11's needs-review bucket is about.
  const account = db
    .insert(accounts)
    .values({
      name: 'Main',
      kind: 'main',
      openingBalanceDate: '2025-07-01',
      openingBalanceCents: 0,
    })
    .returning()
    .get();
  const analyzed = analyzeImport(db, {
    accountId: account.id,
    filename: 'main-2025-07_2026-06.csv',
    bytes: loadFixture('main'),
  });
  commitImport(db, analyzed.importId, { allowUncategorized: true });
});

afterEach(async () => {
  await app.close();
});

async function categoryId(name: string): Promise<number> {
  const row = db.select().from(categories).where(eq(categories.name, name)).get();
  if (!row) throw new Error(`category ${name} not found`);
  return row.id;
}

async function openMonth(month: string) {
  const res = await app.inject({ method: 'GET', url: `/api/budgets/${month}?open=1` });
  return res.json();
}

/** Label every transaction with this normalized counterparty into a category. */
async function labelCounterparty(normalized: string, categoryName: string): Promise<void> {
  const target = await categoryId(categoryName);
  const rows = db.select().from(transactions).all();
  for (const t of rows) {
    if (normalizeCounterparty(t.counterparty) !== normalized) continue;
    db.update(transactions)
      .set({ categoryId: target, categorySource: 'manual' })
      .where(eq(transactions.id, t.id))
      .run();
  }
}

async function labelArchiveId(archiveId: string, categoryName: string): Promise<void> {
  const target = await categoryId(categoryName);
  db.update(transactions)
    .set({ categoryId: target, categorySource: 'manual' })
    .where(eq(transactions.archiveId, archiveId))
    .run();
}

/** Insert a line straight into the month, bypassing the (stage 3) endpoints. */
function insertLine(
  budgetId: number,
  values: Partial<typeof budgetLines.$inferInsert> & {
    kind: 'recurring' | 'adhoc' | 'envelope';
    name: string;
    categoryId: number;
    amountCents: number;
  },
) {
  return db.insert(budgetLines).values({ budgetId, ...values }).returning().get();
}

function budgetIdOf(month: string): number {
  const row = db.select().from(budgets).where(eq(budgets.month, month)).get();
  if (!row) throw new Error(`month ${month} not materialized`);
  return row.id;
}

/**
 * The tie-out identity of criterion 10: the month's M-definition expense total
 * equals what the reconciliation attributes — line actuals + unbudgeted +
 * needs-review. The decomposition is a partition, so this must hold exactly.
 */
function expectTieOut(month: {
  totals: {
    actualCents: number;
    unbudgetedCents: number;
    needsReviewCents: number;
    expenseCents: number;
  };
}): void {
  const t = month.totals;
  expect(t.actualCents + t.unbudgetedCents + t.needsReviewCents).toBe(t.expenseCents);
}

describe('spec 003 — named lines and envelopes', () => {
  it('criterion 6: a named recurring line reconciles by counterparty and its transactions are not double-counted in the category envelope', async () => {
    await labelCounterparty('ELIXIA HELSINKI', 'Health');
    await labelCounterparty('LIDL', 'Health'); // extra Health spend, not the gym

    await openMonth('2025-08');
    const budgetId = budgetIdOf('2025-08');
    const health = await categoryId('Health');
    insertLine(budgetId, {
      kind: 'recurring',
      name: 'Gym',
      categoryId: health,
      amountCents: 4990,
      matchNormalizedCounterparty: 'ELIXIA HELSINKI',
    });
    insertLine(budgetId, { kind: 'envelope', name: 'Health', categoryId: health, amountCents: 20000 });

    const month = await openMonth('2025-08');
    const gym = month.lines.find((l: { name: string }) => l.name === 'Gym');
    const envelope = month.lines.find((l: { kind: string }) => l.kind === 'envelope');

    // The gym's actual is exactly that counterparty's spend for the month.
    const gymSpend = expectedSpend('ELIXIA HELSINKI', '2025-08');
    expect(gym.actualCents).toBe(gymSpend);
    expect(gym.pending).toBe(false);

    // ...and the envelope sees the remainder only — no double counting.
    const allHealth = expectedCategorySpend(health, '2025-08');
    // Guard: both parts must be real spend, or "no double counting" would hold
    // vacuously if a fixture reroll moved these counterparties out of the month.
    expect(gymSpend).toBeGreaterThan(0);
    expect(allHealth).toBeGreaterThan(gymSpend);
    expect(envelope.actualCents).toBe(allHealth - gymSpend);

    const decomposition = month.categories.find(
      (c: { categoryId: number }) => c.categoryId === health,
    );
    expect(decomposition.actualCents).toBe(allHealth);
    expect(decomposition.plannedCents).toBe(4990 + 20000);
    expectTieOut(month);
  });

  it('criterion 7: an envelope takes its category remainder, and a category with spend but no line lands in unbudgeted', async () => {
    await labelCounterparty('LIDL', 'Groceries');
    await labelCounterparty('ELIXIA HELSINKI', 'Health'); // spend, but no line

    await openMonth('2025-08');
    const budgetId = budgetIdOf('2025-08');
    const groceries = await categoryId('Groceries');
    const health = await categoryId('Health');
    insertLine(budgetId, {
      kind: 'envelope',
      name: 'Groceries',
      categoryId: groceries,
      amountCents: 40000,
    });

    const month = await openMonth('2025-08');
    const envelope = month.lines.find((l: { kind: string }) => l.kind === 'envelope');
    const grocerySpend = expectedCategorySpend(groceries, '2025-08');
    const healthSpend = expectedCategorySpend(health, '2025-08');
    // Guards: an empty category would satisfy both assertions with zeros.
    expect(grocerySpend).toBeGreaterThan(0);
    expect(healthSpend).toBeGreaterThan(0);
    expect(envelope.actualCents).toBe(grocerySpend);

    const unbudgeted = month.unbudgeted.find(
      (u: { categoryId: number }) => u.categoryId === health,
    );
    expect(unbudgeted.actualCents).toBe(healthSpend);
    // Note the exclusion is per ENVELOPE, not per line: Groceries has an
    // envelope, so it is NOT unbudgeted.
    expect(
      month.unbudgeted.some((u: { categoryId: number }) => u.categoryId === groceries),
    ).toBe(false);
    expectTieOut(month);
  });

  it('criterion 3 (reconciliation half): the yearly and quarterly fixture lines reconcile against their real charges, with no monthly division', async () => {
    const { yearly, quarterly } = EXPECTED.recurringNonMonthly;
    const other = await categoryId('Other');

    for (const month of [...yearly.months, ...quarterly.months]) {
      await openMonth(month);
      const budgetId = budgetIdOf(month);
      insertLine(budgetId, {
        kind: 'recurring',
        name: 'Home insurance',
        categoryId: other,
        amountCents: -yearly.amountCentsEach,
        matchNormalizedCounterparty: yearly.normalizedCounterparty,
      });
      insertLine(budgetId, {
        kind: 'recurring',
        name: 'Self storage',
        categoryId: other,
        amountCents: -quarterly.amountCentsEach,
        matchNormalizedCounterparty: quarterly.normalizedCounterparty,
      });
    }

    // The yearly charge reconciles whole in its single due month: 60000, not 5000/mo.
    const october = await openMonth(yearly.months[0]!);
    const insurance = october.lines.find((l: { name: string }) => l.name === 'Home insurance');
    expect(insurance.actualCents).toBe(-yearly.amountCentsEach);
    expect(insurance.varianceCents).toBe(0);
    expect(insurance.pending).toBe(false);

    // Each quarterly month reconciles against that month's single 87 EUR charge.
    for (const month of quarterly.months) {
      const view = await openMonth(month);
      const storage = view.lines.find((l: { name: string }) => l.name === 'Self storage');
      expect(storage.actualCents).toBe(-quarterly.amountCentsEach);
      expect(storage.pending).toBe(false);
    }
  });

  it('criterion 16: a monthly line whose charge is absent that month is pending with actual 0, while the other months reconcile', async () => {
    const { absentDueMonth } = EXPECTED.recurringNegativeCases;
    const health = await categoryId('Health');

    for (const month of [...absentDueMonth.months, absentDueMonth.absentMonth]) {
      await openMonth(month);
      insertLine(budgetIdOf(month), {
        kind: 'recurring',
        name: 'Gym',
        categoryId: health,
        amountCents: -absentDueMonth.amountCentsEach,
        matchNormalizedCounterparty: absentDueMonth.normalizedCounterparty,
      });
    }

    const absent = await openMonth(absentDueMonth.absentMonth);
    const gym = absent.lines.find((l: { name: string }) => l.name === 'Gym');
    expect(gym.actualCents).toBe(0);
    expect(gym.pending).toBe(true);
    // Planned but not seen: the full plan is the variance.
    expect(gym.varianceCents).toBe(-absentDueMonth.amountCentsEach);

    for (const month of absentDueMonth.months) {
      const view = await openMonth(month);
      const line = view.lines.find((l: { name: string }) => l.name === 'Gym');
      expect(line.actualCents).toBe(-absentDueMonth.amountCentsEach);
      expect(line.pending).toBe(false);
    }
  });

  it('criterion 17: a drifted yearly bill leaves its nominal month pending and surfaces as unbudgeted in the month it actually posted', async () => {
    const { driftedYearly } = EXPECTED.recurringNegativeCases;
    const transport = await categoryId('Transport');
    await labelCounterparty(driftedYearly.normalizedCounterparty, 'Transport');

    // The line is anchored to the NOMINAL due month only.
    await openMonth(driftedYearly.nominalDueMonth);
    insertLine(budgetIdOf(driftedYearly.nominalDueMonth), {
      kind: 'recurring',
      name: 'Autoliitto',
      categoryId: transport,
      amountCents: -driftedYearly.amountCentsEach,
      matchNormalizedCounterparty: driftedYearly.normalizedCounterparty,
    });

    const nominal = await openMonth(driftedYearly.nominalDueMonth);
    const line = nominal.lines.find((l: { name: string }) => l.name === 'Autoliitto');
    expect(line.actualCents).toBe(0);
    expect(line.pending).toBe(true);

    // Strict within-month matching: the line does NOT reach into March.
    const actual = await openMonth(driftedYearly.actualMonth);
    const unbudgetedTransport = actual.unbudgeted.find(
      (u: { categoryId: number }) => u.categoryId === transport,
    );
    expect(unbudgetedTransport.actualCents).toBe(-driftedYearly.amountCentsEach);
    expectTieOut(actual);
  });

  it('criterion 14: a named line consumes across categories and the LINE category wins for reporting (recurring and ad-hoc)', async () => {
    await labelCounterparty('NETFLIX.COM', 'Subscriptions');
    await labelCounterparty('ELIXIA HELSINKI', 'Health');

    await openMonth('2025-08');
    const budgetId = budgetIdOf('2025-08');
    const subscriptions = await categoryId('Subscriptions');
    const entertainment = await categoryId('Entertainment');
    const health = await categoryId('Health');

    // A recurring named line and an ad-hoc named line, both in Subscriptions.
    insertLine(budgetId, {
      kind: 'recurring',
      name: 'Netflix',
      categoryId: subscriptions,
      amountCents: 1799,
      matchNormalizedCounterparty: 'NETFLIX.COM',
    });
    insertLine(budgetId, {
      kind: 'adhoc',
      name: 'Gym (one-off)',
      categoryId: subscriptions,
      amountCents: 4990,
      matchNormalizedCounterparty: 'ELIXIA HELSINKI',
    });
    // Entertainment gets an envelope so we can watch its remainder.
    insertLine(budgetId, {
      kind: 'envelope',
      name: 'Entertainment',
      categoryId: entertainment,
      amountCents: 10000,
    });

    const before = await openMonth('2025-08');
    const netflixBefore = before.lines.find((l: { name: string }) => l.name === 'Netflix');
    const gymBefore = before.lines.find((l: { name: string }) => l.name === 'Gym (one-off)');
    const entertainmentBefore = before.categories.find(
      (c: { categoryId: number }) => c.categoryId === entertainment,
    );

    // Relabel BOTH matched counterparties into Entertainment / Health.
    await labelCounterparty('NETFLIX.COM', 'Entertainment');
    await labelCounterparty('ELIXIA HELSINKI', 'Entertainment');

    const after = await openMonth('2025-08');
    const netflixAfter = after.lines.find((l: { name: string }) => l.name === 'Netflix');
    const gymAfter = after.lines.find((l: { name: string }) => l.name === 'Gym (one-off)');

    // The named lines' actuals are unchanged by the relabel.
    expect(netflixAfter.actualCents).toBe(netflixBefore.actualCents);
    expect(gymAfter.actualCents).toBe(gymBefore.actualCents);

    // The consumed amounts are reported under the LINE's category (Subscriptions).
    const subsAfter = after.categories.find(
      (c: { categoryId: number }) => c.categoryId === subscriptions,
    );
    expect(subsAfter.actualCents).toBe(netflixAfter.actualCents + gymAfter.actualCents);

    // Entertainment's envelope reconciles against a remainder EXCLUDING them.
    const entertainmentAfter = after.categories.find(
      (c: { categoryId: number }) => c.categoryId === entertainment,
    );
    expect(entertainmentAfter.envelopeActualCents).toBe(
      entertainmentBefore.envelopeActualCents,
    );

    // The month total is unaffected — only per-category attribution moved.
    expect(after.totals.expenseCents).toBe(before.totals.expenseCents);
    expect(after.totals.actualCents + after.totals.unbudgetedCents + after.totals.needsReviewCents)
      .toBe(before.totals.actualCents + before.totals.unbudgetedCents + before.totals.needsReviewCents);
    // Health no longer holds the gym spend: the gym rows were relabelled OUT of
    // Health, and the named line reports them under Subscriptions either way, so
    // Health must not be carrying that spend anywhere in the decomposition.
    const healthAfter = after.categories.find(
      (c: { categoryId: number }) => c.categoryId === health,
    );
    const healthUnbudgeted = after.unbudgeted.find(
      (u: { categoryId: number }) => u.categoryId === health,
    );
    expect(healthAfter?.actualCents ?? 0).toBe(0);
    expect(healthUnbudgeted?.actualCents ?? 0).toBe(0);

    expectTieOut(after);
  });

  it('criterion 21 (computation): an explicit 0 envelope reconciles as overspend and is not unbudgeted, unlike no envelope at all', async () => {
    await labelCounterparty('LIDL', 'Groceries');
    const groceries = await categoryId('Groceries');

    // No envelope: the category's spend is unbudgeted.
    await openMonth('2025-08');
    const withoutEnvelope = await openMonth('2025-08');
    const spend = expectedCategorySpend(groceries, '2025-08');
    expect(spend).toBeGreaterThan(0); // guard: a zero-spend category proves nothing here
    expect(
      withoutEnvelope.unbudgeted.find((u: { categoryId: number }) => u.categoryId === groceries)
        .actualCents,
    ).toBe(spend);
    expectTieOut(withoutEnvelope);

    // An explicit 0 envelope: reconciles against the line as full overspend.
    insertLine(budgetIdOf('2025-08'), {
      kind: 'envelope',
      name: 'Groceries',
      categoryId: groceries,
      amountCents: 0,
    });
    const withZero = await openMonth('2025-08');
    const envelope = withZero.lines.find((l: { kind: string }) => l.kind === 'envelope');
    expect(envelope.amountCents).toBe(0);
    expect(envelope.actualCents).toBe(spend);
    expect(envelope.varianceCents).toBe(-spend); // full overspend
    expect(
      withZero.unbudgeted.some((u: { categoryId: number }) => u.categoryId === groceries),
    ).toBe(false);
    expectTieOut(withZero);
  });

  it('criterion 22 (computation): per-category decomposition sums named + envelope, and the partition reproduces the month totals', async () => {
    await labelCounterparty('ELIXIA HELSINKI', 'Transport');
    await labelCounterparty('LIDL', 'Transport');

    await openMonth('2025-08');
    const budgetId = budgetIdOf('2025-08');
    const transport = await categoryId('Transport');

    // Double-planned: a named ad-hoc line AND an envelope in one category.
    insertLine(budgetId, {
      kind: 'adhoc',
      name: 'Car service',
      categoryId: transport,
      amountCents: 4990,
      matchNormalizedCounterparty: 'ELIXIA HELSINKI',
    });
    insertLine(budgetId, {
      kind: 'envelope',
      name: 'Transport',
      categoryId: transport,
      amountCents: 55000,
    });

    const month = await openMonth('2025-08');
    const decomposition = month.categories.find(
      (c: { categoryId: number }) => c.categoryId === transport,
    );
    const named = month.lines.find((l: { name: string }) => l.name === 'Car service');
    const envelope = month.lines.find((l: { kind: string }) => l.kind === 'envelope');

    // Guards: both halves must carry real actuals for the split to mean anything.
    expect(named.actualCents).toBeGreaterThan(0);
    expect(envelope.actualCents).toBeGreaterThan(0);

    expect(decomposition.plannedCents).toBe(4990 + 55000);
    expect(decomposition.namedPlannedCents).toBe(4990);
    expect(decomposition.envelopePlannedCents).toBe(55000);
    expect(decomposition.actualCents).toBe(named.actualCents + envelope.actualCents);

    // The partition: Σ categories + unbudgeted + needs-review == the month's
    // expense total, and Σ category actuals == the line-actual total.
    const categorySum = month.categories.reduce(
      (s: number, c: { actualCents: number }) => s + c.actualCents,
      0,
    );
    expect(categorySum).toBe(month.totals.actualCents);
    expectTieOut(month);
  });
});

describe('spec 003 — tie-out and needs-review (criteria 10, 11)', () => {
  it('criterion 10: the month tie-out holds and the PALKKA salary appears in neither the expense total nor unbudgeted', async () => {
    const month = await openMonth('2026-04');

    // The M definition, computed directly from transactions — the same query
    // spec 004 will use for its expense bucket.
    expect(month.totals.expenseCents).toBe(EXPECTED.needsReview.monthExpenseCentsWithRow);
    expectTieOut(month);

    // The fixture derives that constant from transaction TYPE (PALKKA /
    // OMA TILISIIRTO) as a proxy for 003-F's category rule. Recompute it here
    // from the real rule — exclude Transfer and every income-source category,
    // keep uncategorized — so the proxy cannot drift out of agreement silently.
    // Without this, adding a labeling rule that assigns an income-source
    // category would make criterion 10 assert two numbers that are both wrong.
    expect(mDefinitionExpenseByCategory('2026-04')).toBe(
      EXPECTED.needsReview.monthExpenseCentsWithRow,
    );

    // Income is excluded from BOTH sides: no salary in the expense total, and
    // no Income category anywhere in unbudgeted or needs-review.
    const income = await categoryId('Income');
    expect(month.unbudgeted.some((u: { categoryId: number }) => u.categoryId === income)).toBe(
      false,
    );
    const salaryRows = db
      .select()
      .from(transactions)
      .where(and(eq(transactions.type, 'PALKKA'), eq(transactions.categoryId, income)))
      .all()
      .filter((t) => t.paymentDate.startsWith('2026-04'));
    expect(salaryRows.length).toBeGreaterThan(0);
    for (const row of salaryRows) {
      expect(
        month.needsReview.some((r: { transactionId: number }) => r.transactionId === row.id),
      ).toBe(false);
    }

    // Transfer is likewise absent from both.
    const transfer = await categoryId('Transfer');
    expect(month.unbudgeted.some((u: { categoryId: number }) => u.categoryId === transfer)).toBe(
      false,
    );
  });

  it('criterion 11: an uncategorized row appears in needs-review with its SIGNED amount and the tie-out holds', async () => {
    const fixture = EXPECTED.needsReview;
    const month = await openMonth(fixture.month);

    const row = month.needsReview.find(
      (r: { counterparty: string; amountCents: number }) =>
        r.counterparty === fixture.counterparty && r.amountCents === fixture.amountCents,
    );
    expect(row).toBeDefined();
    // Signed and POSITIVE: a payback, not spending.
    expect(row.amountCents).toBe(fixture.amountCents);
    expect(row.amountCents).toBeGreaterThan(0);

    expect(month.totals.expenseCents).toBe(fixture.monthExpenseCentsWithRow);
    expectTieOut(month);
  });

  it('criterion 11a: labeling the payback into an expense category leaves the month total alone and nets that category down', async () => {
    const fixture = EXPECTED.needsReview;
    const restaurants = await categoryId('Restaurants & Cafés');

    // Give Restaurants some real charges plus an envelope to reconcile against.
    await labelCounterparty('SUBWAY', 'Restaurants & Cafés');
    await openMonth(fixture.month);
    insertLine(budgetIdOf(fixture.month), {
      kind: 'envelope',
      name: 'Restaurants',
      categoryId: restaurants,
      amountCents: 20000,
    });

    const before = await openMonth(fixture.month);
    const chargesBefore = before.categories.find(
      (c: { categoryId: number }) => c.categoryId === restaurants,
    ).actualCents;

    await labelArchiveId(fixture.archiveId, 'Restaurants & Cafés');
    const after = await openMonth(fixture.month);

    // The row stays in M, so the month expense total is UNCHANGED.
    expect(after.totals.expenseCents).toBe(fixture.monthExpenseCentsWithRow);
    expect(after.totals.expenseCents).toBe(before.totals.expenseCents);

    // ...and the receiving category's actual nets the positive amount down.
    const chargesAfter = after.categories.find(
      (c: { categoryId: number }) => c.categoryId === restaurants,
    ).actualCents;
    expect(chargesAfter).toBe(chargesBefore - fixture.amountCents);

    // It has left the needs-review bucket.
    expect(
      after.needsReview.some(
        (r: { amountCents: number }) => r.amountCents === fixture.amountCents,
      ),
    ).toBe(false);
    expectTieOut(after);
  });

  it('criterion 11b: labeling the payback into Transfer removes it from M and changes the month total identically on both sides', async () => {
    const fixture = EXPECTED.needsReview;
    const before = await openMonth(fixture.month);
    expect(before.totals.expenseCents).toBe(fixture.monthExpenseCentsWithRow);

    await labelArchiveId(fixture.archiveId, 'Transfer');
    const after = await openMonth(fixture.month);

    // The row leaves M entirely — correct, it was never expense spending.
    expect(after.totals.expenseCents).toBe(fixture.monthExpenseCentsWithoutRow);
    expect(after.totals.expenseCents).toBe(
      before.totals.expenseCents + fixture.amountCents,
    );
    expect(
      after.needsReview.some(
        (r: { amountCents: number }) => r.amountCents === fixture.amountCents,
      ),
    ).toBe(false);
    expectTieOut(after);
  });

  it('criterion 11b: labeling the payback into an income-source category removes it from M the same way', async () => {
    const fixture = EXPECTED.needsReview;
    await labelArchiveId(fixture.archiveId, 'Income');
    const after = await openMonth(fixture.month);

    expect(after.totals.expenseCents).toBe(fixture.monthExpenseCentsWithoutRow);
    expectTieOut(after);
  });
});

// --- Expectation helpers ---------------------------------------------------
// Computed from transactions using the M definition, so they are the same query
// spec 004 will use rather than a restatement of the implementation.

function expectedSpend(normalized: string, month: string): number {
  return db
    .select()
    .from(transactions)
    .all()
    .filter((t) => t.paymentDate.startsWith(month))
    .filter((t) => normalizeCounterparty(t.counterparty) === normalized)
    .reduce((sum, t) => sum - t.amountCents, 0);
}

/**
 * The month's expense total under 003-F's **category** rule: every transaction
 * in the month except those in `Transfer` or an income-source category,
 * uncategorized rows included. No account filter — `selectM` has none either.
 */
function mDefinitionExpenseByCategory(month: string): number {
  const excluded = new Set(
    db
      .select()
      .from(categories)
      .all()
      .filter((c) => c.systemKey === 'transfer' || c.isIncomeSource)
      .map((c) => c.id),
  );
  return db
    .select()
    .from(transactions)
    .all()
    .filter((t) => t.paymentDate.startsWith(month))
    .filter((t) => t.categoryId === null || !excluded.has(t.categoryId))
    .reduce((sum, t) => sum - t.amountCents, 0);
}

function expectedCategorySpend(categoryIdValue: number, month: string): number {
  return db
    .select()
    .from(transactions)
    .all()
    .filter((t) => t.paymentDate.startsWith(month))
    .filter((t) => t.categoryId === categoryIdValue)
    .reduce((sum, t) => sum - t.amountCents, 0);
}
