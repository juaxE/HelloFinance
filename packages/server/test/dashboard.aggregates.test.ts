/**
 * Spec 004 stage 1 — the aggregation endpoints.
 *
 * Runs over the seeded fixture state (both accounts, both CSVs committed with
 * `allowUncategorized`, the seeded templates and assets), so every figure is the
 * fixture's own and is asserted against `fixtures/expected.json` where the
 * criterion names it (CLAUDE.md validation §5).
 *
 * Criteria covered here: 1, 2, 5, 6, 7.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type {
  BudgetVsActual,
  CashFlowPoint,
  CategoryBreakdownEntry,
  IncomeBreakdown,
  RecurringCommitments,
} from '@finance/shared';
import { buildApp } from '../src/app';
import type { Db } from '../src/db/client';
import { budgets, categories, recurringTemplates, transactions } from '../src/db/schema';
import { reconcileMonth } from '../src/budgets/reconcile';
import { recurringCommitments } from '../src/dashboard/aggregates';
import { normalizeCounterparty } from '../src/import/normalize';
import { createTestDb, EXPECTED, FIXTURE_MONTHS, seedFixtureApp } from './helpers';

let app: FastifyInstance;
let db: Db;

/** Pinned inside the fixture span; the fixtures end 2026-06. */
const NOW = new Date('2026-06-15T12:00:00.000Z');
const MONTH = '2026-06';

beforeEach(async () => {
  db = createTestDb();
  app = buildApp(db, { now: () => NOW });
  await app.ready();
  seedFixtureApp(db);
});

afterEach(async () => {
  await app.close();
});

async function get<T>(url: string): Promise<T> {
  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode, `${url} -> ${res.body}`).toBe(200);
  return res.json() as T;
}

function categoryId(name: string): number {
  const row = db.select().from(categories).where(eq(categories.name, name)).get();
  if (!row) throw new Error(`category ${name} not found`);
  return row.id;
}

/**
 * Label every positive main-account inflow that is NOT salary and NOT a transfer
 * into a new income-source category.
 *
 * This is what makes criterion 1's salary-vs-other split observable: on a fresh
 * import the only categories assigned are the two type hints, so every other
 * inflow is uncategorized and therefore sits in the EXPENSE bucket (where, being
 * positive, it nets expenses down). Moving it into an income-source category is
 * the "future Other income / Kela category" decision 004-A describes.
 */
function labelOtherInflowsAsIncome(): number {
  const other = db
    .insert(categories)
    .values({ name: 'Other income', isIncomeSource: true })
    .returning()
    .get();
  for (const t of db.select().from(transactions).all()) {
    if (t.amountCents <= 0 || t.categoryId !== null) continue;
    db.update(transactions)
      .set({ categoryId: other.id, categorySource: 'manual' })
      .where(eq(transactions.id, t.id))
      .run();
  }
  return other.id;
}

describe('spec 004 — cash flow and income sources', () => {
  it('criterion 1: cash flow excludes Transfer / OMA TILISIIRTO, in a month that actually contains transfers', async () => {
    // 2025-12 has the largest transfer volume in the fixture, so the exclusion
    // is doing real work here rather than passing on a month with none.
    const month = '2025-12';
    const expectedMonth = EXPECTED.cashFlowMain.byMonth[month]!;
    expect(expectedMonth.transferExcludedCents).not.toBe(0);

    const points = await get<CashFlowPoint[]>('/api/dashboard/cash-flow?window=12');
    const point = points.find((p) => p.month === month)!;

    // On a fresh import only the type hints assign categories, so income is
    // exactly the PALKKA rows and every other inflow is still in the expense
    // bucket, netting it down. Both sides derive from expected.json.
    const salary = EXPECTED.incomeSourcesMain.byMonth[month]!.salaryCents;
    const otherInflow = EXPECTED.incomeSourcesMain.byMonth[month]!.otherInflowCents;
    expect(point.incomeCents).toBe(salary);
    expect(point.expensesCents).toBe(expectedMonth.expensesCents - otherInflow);
    expect(point.netCents).toBe(point.incomeCents - point.expensesCents);

    // The transfer legs are absent from BOTH sides, not merely netted out.
    // Their SIGNED sum across the two accounts is zero — they are paired legs of
    // the same moves — so the assertion has to be against the inflow legs, which
    // is exactly what a sign-based income rule would wrongly have counted.
    const transferRows = db
      .select()
      .from(transactions)
      .all()
      .filter((t) => t.categoryId === categoryId('Transfer'))
      .filter((t) => t.paymentDate.startsWith(month));
    expect(transferRows.length).toBeGreaterThan(0);
    const transferInflows = transferRows
      .filter((t) => t.amountCents > 0)
      .reduce((s, t) => s + t.amountCents, 0);
    expect(transferInflows).toBeGreaterThan(0);
    expect(point.incomeCents).not.toBe(salary + transferInflows);
  });

  it('criterion 1: with other inflows in an income-source category, every month ties out to cashFlowMain', async () => {
    labelOtherInflowsAsIncome();
    const points = await get<CashFlowPoint[]>('/api/dashboard/cash-flow?window=12');
    expect(points.map((p) => p.month)).toEqual(FIXTURE_MONTHS);

    for (const point of points) {
      const expectedMonth = EXPECTED.cashFlowMain.byMonth[point.month]!;
      expect([point.month, point.incomeCents]).toEqual([point.month, expectedMonth.incomeCents]);
      expect([point.month, point.expensesCents]).toEqual([point.month, expectedMonth.expensesCents]);
      expect([point.month, point.netCents]).toEqual([point.month, expectedMonth.netCents]);
    }
  });

  it('criterion 1: the income breakdown separates salary (PALKKA) from other inflows', async () => {
    labelOtherInflowsAsIncome();

    for (const month of FIXTURE_MONTHS) {
      const expectedMonth = EXPECTED.incomeSourcesMain.byMonth[month]!;
      const income = await get<IncomeBreakdown>(`/api/dashboard/income?month=${month}`);
      expect([month, income.salaryCents]).toEqual([month, expectedMonth.salaryCents]);
      expect([month, income.otherIncomeCents]).toEqual([month, expectedMonth.otherInflowCents]);
      // The split is per category, and salary is the Income built-in.
      expect(income.byCategory.reduce((s, c) => s + c.amountCents, 0)).toBe(
        expectedMonth.salaryCents + expectedMonth.otherInflowCents,
      );
    }

    const income = await get<IncomeBreakdown>(`/api/dashboard/income?month=${MONTH}`);
    const salaryLine = income.byCategory.find((c) => c.categoryId === categoryId('Income'));
    expect(salaryLine?.amountCents).toBe(EXPECTED.incomeSourcesMain.byMonth[MONTH]!.salaryCents);
  });
});

describe('spec 004 — category breakdown', () => {
  it('criterion 2: the breakdown sums across expense categories to the cash-flow expense total', async () => {
    for (const month of FIXTURE_MONTHS) {
      const [breakdown, points] = await Promise.all([
        get<CategoryBreakdownEntry[]>(`/api/dashboard/categories?month=${month}`),
        get<CashFlowPoint[]>('/api/dashboard/cash-flow?window=12'),
      ]);
      const summed = breakdown.reduce((s, c) => s + c.amountCents, 0);
      const expensesCents = points.find((p) => p.month === month)!.expensesCents;
      expect([month, summed]).toEqual([month, expensesCents]);
    }
  });

  it('criterion 2: a positive reimbursement reduces its category magnitude', async () => {
    const { month, archiveId, amountCents } = EXPECTED.needsReview;
    const restaurants = categoryId('Restaurants & Cafés');
    expect(amountCents).toBeGreaterThan(0); // it is an inflow — a payback

    const before = await get<CategoryBreakdownEntry[]>(`/api/dashboard/categories?month=${month}`);
    const restaurantsBefore =
      before.find((c) => c.categoryId === restaurants)?.amountCents ?? 0;

    // Label the payback into an EXPENSE category: it must net that category
    // down, never count as income (decision 004-A).
    const row = db.select().from(transactions).where(eq(transactions.archiveId, archiveId)).get()!;
    db.update(transactions)
      .set({ categoryId: restaurants, categorySource: 'manual' })
      .where(eq(transactions.id, row.id))
      .run();

    const after = await get<CategoryBreakdownEntry[]>(`/api/dashboard/categories?month=${month}`);
    const restaurantsAfter = after.find((c) => c.categoryId === restaurants)!.amountCents;
    expect(restaurantsAfter).toBe(restaurantsBefore - amountCents);

    // ...and it is still not income, and the month's expense total is unmoved
    // (the row was already in the expense bucket as Uncategorized).
    const income = await get<IncomeBreakdown>(`/api/dashboard/income?month=${month}`);
    expect(income.byCategory.some((c) => c.categoryId === restaurants)).toBe(false);
    expect(after.reduce((s, c) => s + c.amountCents, 0)).toBe(
      before.reduce((s, c) => s + c.amountCents, 0),
    );
  });

  it('criterion 2: Uncategorized is its own slice, not folded into another category', async () => {
    const breakdown = await get<CategoryBreakdownEntry[]>(`/api/dashboard/categories?month=${MONTH}`);
    const uncategorized = breakdown.find((c) => c.categoryId === null);
    expect(uncategorized).toBeDefined();
    expect(uncategorized!.name).toBe('Uncategorized');
    expect(uncategorized!.amountCents).not.toBe(0);
    // Sorted by magnitude, biggest first.
    const magnitudes = breakdown.map((c) => Math.abs(c.amountCents));
    expect(magnitudes).toEqual([...magnitudes].sort((a, b) => b - a));
  });
});

describe('spec 004 — budget vs actual', () => {
  it('criterion 5: budget-vs-actual totals equal spec 003 reconciliation for the same month', async () => {
    // Materialize the month through spec 003's own endpoint, then set an
    // envelope, so there is a real plan on both sides.
    await app.inject({ method: 'GET', url: `/api/budgets/${MONTH}?open=1` });
    await app.inject({
      method: 'PUT',
      url: `/api/budgets/${MONTH}/envelopes`,
      payload: { envelopes: [{ categoryId: categoryId('Groceries'), amountCents: 45000 }] },
    });

    const card = await get<BudgetVsActual>(`/api/dashboard/budget-vs-actual?month=${MONTH}`);
    const budget = db.select().from(budgets).where(eq(budgets.month, MONTH)).get()!;
    const reconciliation = reconcileMonth(db, budget.id, MONTH);

    expect(card.materialized).toBe(true);
    expect(card.totals).toEqual(reconciliation.totals);
    expect(card.lines.map((l) => [l.id, l.actualCents, l.varianceCents])).toEqual(
      reconciliation.lines.map((l) => [l.id, l.actualCents, l.varianceCents]),
    );

    // ...and the expense total is the SAME number the cash-flow card shows.
    const points = await get<CashFlowPoint[]>('/api/dashboard/cash-flow?window=12');
    expect(card.totals.expenseCents).toBe(points.find((p) => p.month === MONTH)!.expensesCents);
  });

  it('criterion 5: an unmaterialized month reports its real expense total without creating the month', async () => {
    const month = '2025-08';
    const card = await get<BudgetVsActual>(`/api/dashboard/budget-vs-actual?month=${month}`);
    expect(card.materialized).toBe(false);
    expect(card.lines).toEqual([]);

    const points = await get<CashFlowPoint[]>('/api/dashboard/cash-flow?window=12');
    expect(card.totals.expenseCents).toBe(points.find((p) => p.month === month)!.expensesCents);
    // Looking at the dashboard must not materialize a budget month (003-C).
    expect(db.select().from(budgets).where(eq(budgets.month, month)).get()).toBeUndefined();
  });
});

describe('spec 004 — normalized monthly commitments', () => {
  it("criterion 6: the spec's worked example, with half-up-per-template rounding", async () => {
    // The four templates from the criterion, constructed here rather than
    // seeded. 1000 €/yr is non-divisible (100000/12 = 8333.33…) and pins
    // truncation-vs-rounding; 12,33 € every 2 months lands exactly on half a
    // cent (1233/2 = 616.5) and must round AWAY FROM ZERO to 617.
    db.delete(recurringTemplates).run();
    const cases = [
      ['Insurance', 60000, 12, 5000],
      ['Storage', 8700, 3, 2900],
      ['Rent', 100000, 1, 100000],
      ['Yearly odd', 100000, 12, 8333],
    ] as const;
    for (const [name, amountCents, intervalMonths] of cases) {
      db.insert(recurringTemplates)
        .values({
          name,
          categoryId: categoryId('Other'),
          amountCents,
          intervalMonths,
          expectedDayOfMonth: 1,
          startMonth: '2025-07',
          matchNormalizedCounterparty: name.toUpperCase(),
        })
        .run();
    }

    const stat = await get<RecurringCommitments>('/api/dashboard/recurring-commitments');
    for (const [name, , , expectedEquivalent] of cases) {
      expect([name, stat.byTemplate.find((t) => t.name === name)!.monthlyEquivalentCents]).toEqual([
        name,
        expectedEquivalent,
      ]);
    }
    expect(stat.normalizedMonthlyCents).toBe(116233);

    // The exact-half case rounds away from zero, not to even.
    const halfCent = recurringCommitments(db, MONTH);
    expect(halfCent.normalizedMonthlyCents).toBe(116233);
    db.insert(recurringTemplates)
      .values({
        name: 'Bimonthly',
        categoryId: categoryId('Other'),
        amountCents: 1233,
        intervalMonths: 2,
        expectedDayOfMonth: 1,
        startMonth: '2025-07',
        matchNormalizedCounterparty: 'BIMONTHLY',
      })
      .run();
    expect(recurringCommitments(db, MONTH).byTemplate.at(-1)!.monthlyEquivalentCents).toBe(617);
  });

  it('criterion 6: the seeded template set matches fixtures/expected.json, in every month alike', async () => {
    const stat = await get<RecurringCommitments>('/api/dashboard/recurring-commitments');
    expect(stat.normalizedMonthlyCents).toBe(EXPECTED.recurringCommitments.normalizedMonthlyCents);
    expect(
      stat.byTemplate.map((t) => [t.name, t.monthlyEquivalentCents]).sort(),
    ).toEqual(
      EXPECTED.recurringCommitments.byTemplate.map((t) => [t.name, t.monthlyEquivalentCents]).sort(),
    );

    // Identical in every month regardless of which charge is actually due —
    // "active this month", not "due this month". The yearly Home insurance
    // starts 2025-10, so months before that legitimately differ.
    const fromOctober = FIXTURE_MONTHS.filter((m) => m >= '2025-10');
    for (const month of fromOctober) {
      expect([month, recurringCommitments(db, month).normalizedMonthlyCents]).toEqual([
        month,
        EXPECTED.recurringCommitments.normalizedMonthlyCents,
      ]);
    }
  });

  it('criterion 6: the commitments figure does not affect cash-flow or budget totals', async () => {
    const before = await get<CashFlowPoint[]>('/api/dashboard/cash-flow?window=12');
    const beforeCard = await get<BudgetVsActual>(`/api/dashboard/budget-vs-actual?month=${MONTH}`);

    db.insert(recurringTemplates)
      .values({
        name: 'Newly added yearly',
        categoryId: categoryId('Other'),
        amountCents: 240000,
        intervalMonths: 12,
        expectedDayOfMonth: 1,
        startMonth: '2025-07',
        matchNormalizedCounterparty: 'NEWLY ADDED YEARLY',
      })
      .run();

    const stat = await get<RecurringCommitments>('/api/dashboard/recurring-commitments');
    expect(stat.normalizedMonthlyCents).toBe(
      EXPECTED.recurringCommitments.normalizedMonthlyCents + 20000,
    );
    // Real transactions drive the money figures; the indicator is display only.
    expect(await get<CashFlowPoint[]>('/api/dashboard/cash-flow?window=12')).toEqual(before);
    expect(await get<BudgetVsActual>(`/api/dashboard/budget-vs-actual?month=${MONTH}`)).toEqual(
      beforeCard,
    );
  });
});

describe('spec 004 — 003-M attribution divergence', () => {
  /**
   * Criterion 7. The relabel MUST use `scope: 'one_off'`: spec 002's
   * `update_rule` scope is retroactive (002 criterion 13), so on a seed with a
   * monthly Spotify charge it would silently move EVERY month's breakdown, not
   * the one under test. The neighbouring-month assertions below are the guard
   * that the scope was right.
   */
  it('criterion 7: relabelling moves the amount in 004 but not in 003, and both totals are unchanged and equal', async () => {
    // 2026-05, not the current month: the fixture's monthly Spotify charge runs
    // to 2026-05 and skips June. Neighbouring months on both sides still carry a
    // charge, which is what makes the scope guard below meaningful.
    const month = '2026-05';
    const subscriptions = categoryId('Subscriptions');
    const entertainment = categoryId('Entertainment');

    // A Spotify charge in the month under test, and the SPOTIFY-keyed named line
    // in Subscriptions that consumes it (the seed ships no such line).
    const spotify = db
      .select()
      .from(transactions)
      .all()
      .find(
        (t) =>
          t.paymentDate.startsWith(month) && normalizeCounterparty(t.counterparty) === 'SPOTIFY',
      );
    if (!spotify) throw new Error(`no SPOTIFY transaction in ${month}`);
    const magnitude = -spotify.amountCents;
    expect(magnitude).toBeGreaterThan(0);

    await app.inject({ method: 'GET', url: `/api/budgets/${month}?open=1` });
    const created = await app.inject({
      method: 'POST',
      url: `/api/budgets/${month}/lines`,
      payload: {
        kind: 'adhoc',
        name: 'Spotify',
        categoryId: subscriptions,
        amountCents: magnitude,
        matchNormalizedCounterparty: 'SPOTIFY',
      },
    });
    expect(created.statusCode).toBe(201);

    const budgetId = db.select().from(budgets).where(eq(budgets.month, month)).get()!.id;
    const neighbours = ['2026-03', '2026-04'];

    const before = {
      breakdown: await get<CategoryBreakdownEntry[]>(`/api/dashboard/categories?month=${month}`),
      reconciliation: reconcileMonth(db, budgetId, month),
      neighbours: await Promise.all(
        neighbours.map((m) => get<CategoryBreakdownEntry[]>(`/api/dashboard/categories?month=${m}`)),
      ),
    };
    const amountIn = (rows: CategoryBreakdownEntry[], id: number): number =>
      rows.find((c) => c.categoryId === id)?.amountCents ?? 0;

    // Before: 003's named line has consumed the charge and reports it under the
    // LINE's category, Subscriptions. (The category aggregate also carries the
    // seeded Netflix line, so the line's own actual is what pins the charge.)
    const spotifyLine = (r: typeof before.reconciliation) =>
      r.lines.find((l) => l.matchNormalizedCounterparty === 'SPOTIFY')!;
    const subscriptionsTotal = (r: typeof before.reconciliation) =>
      r.categories.find((c) => c.categoryId === subscriptions)!.actualCents;
    expect(spotifyLine(before.reconciliation).actualCents).toBe(magnitude);

    // The relabel — one-off scope, so no rule is written and no other month moves.
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${spotify.id}`,
      payload: { categoryId: entertainment, scope: 'one_off' },
    });
    expect(patched.statusCode).toBe(200);

    const after = {
      breakdown: await get<CategoryBreakdownEntry[]>(`/api/dashboard/categories?month=${month}`),
      reconciliation: reconcileMonth(db, budgetId, month),
      neighbours: await Promise.all(
        neighbours.map((m) => get<CategoryBreakdownEntry[]>(`/api/dashboard/categories?month=${m}`)),
      ),
    };

    // 004 moves the amount to Entertainment (transaction-category attribution).
    expect(amountIn(after.breakdown, entertainment)).toBe(
      amountIn(before.breakdown, entertainment) + magnitude,
    );
    expect(amountIn(after.breakdown, subscriptions)).toBe(amountIn(before.breakdown, subscriptions));

    // 003 still reports it under Subscriptions (the line's category, 003-G):
    // the line consumed it, and the line's category wins there. Nothing about
    // 003's per-category split moved, and Entertainment — which has no line —
    // never appears on that side at all.
    expect(spotifyLine(after.reconciliation).actualCents).toBe(magnitude);
    expect(subscriptionsTotal(after.reconciliation)).toBe(subscriptionsTotal(before.reconciliation));
    expect(
      after.reconciliation.categories.find((c) => c.categoryId === entertainment),
    ).toBeUndefined();

    // Both sides' month expense totals are unchanged by the relabel, and equal.
    const total = (rows: CategoryBreakdownEntry[]): number =>
      rows.reduce((s, c) => s + c.amountCents, 0);
    expect(total(after.breakdown)).toBe(total(before.breakdown));
    expect(after.reconciliation.totals.expenseCents).toBe(
      before.reconciliation.totals.expenseCents,
    );
    expect(total(after.breakdown)).toBe(after.reconciliation.totals.expenseCents);

    // The scope guard: `update_rule` would have relabelled every other month's
    // Spotify charge too. Nothing outside the month under test moved.
    expect(after.neighbours).toEqual(before.neighbours);
  });
});
