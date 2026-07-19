/**
 * The dashboard's flow trends: income, spending by category, and budget vs
 * actual across a window rather than for a single month.
 *
 * A flow accumulates over a period, so the month in progress is an INCOMPLETE
 * period, not a small one. Every point here carries `partial`, and the tests
 * below pin both that flag and the rule that partial months are excluded from
 * anything summed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type {
  BudgetTrendPoint,
  BudgetVsActual,
  CashFlowPoint,
  CategoryBreakdownEntry,
  CategoryTrend,
  IncomeBreakdown,
  IncomePoint,
} from '@finance/shared';
import { TOP_SPENDING_CATEGORIES } from '@finance/shared';
import { buildApp } from '../src/app';
import type { Db } from '../src/db/client';
import { categories, transactions } from '../src/db/schema';
import { createTestDb, seedFixtureApp } from './helpers';

let app: FastifyInstance;
let db: Db;

/** Pinned inside the fixture span; the fixtures end 2026-06. */
const NOW = new Date('2026-06-15T12:00:00.000Z');
const CURRENT_MONTH = '2026-06';

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

describe('the partial-month flag', () => {
  it('marks exactly the current month across every flow trend', async () => {
    const [income, cash, spending, budget] = await Promise.all([
      get<IncomePoint[]>('/api/dashboard/income-trend?window=12'),
      get<CashFlowPoint[]>('/api/dashboard/cash-flow?window=12'),
      get<CategoryTrend>('/api/dashboard/category-trend?window=12'),
      get<BudgetTrendPoint[]>('/api/dashboard/budget-trend?window=12'),
    ]);

    for (const [label, months] of [
      ['income', income.map((p) => ({ month: p.month, partial: p.partial }))],
      ['cash flow', cash.map((p) => ({ month: p.month, partial: p.partial }))],
      ['spending', spending.months],
      ['budget', budget.map((p) => ({ month: p.month, partial: p.partial }))],
    ] as const) {
      const flagged = months.filter((m) => m.partial).map((m) => m.month);
      expect(flagged, label).toEqual([CURRENT_MONTH]);
      expect(months.at(-1)!.month, label).toBe(CURRENT_MONTH);
    }
  });

  it('net worth carries no partial-period flag — a balance is a stock', async () => {
    const points = await get<Record<string, unknown>[]>('/api/dashboard/net-worth?window=12');
    expect(points.every((p) => !('partial' in p))).toBe(true);
  });
});

describe('income trend', () => {
  it('reports the same salary and other-income the per-month endpoint does', async () => {
    const trend = await get<IncomePoint[]>('/api/dashboard/income-trend?window=6');

    for (const point of trend) {
      const single = await get<IncomeBreakdown>(`/api/dashboard/income?month=${point.month}`);
      expect(point.salaryCents, point.month).toBe(single.salaryCents);
      expect(point.otherIncomeCents, point.month).toBe(single.otherIncomeCents);
    }
  });

  it('honours the window, oldest first', async () => {
    const trend = await get<IncomePoint[]>('/api/dashboard/income-trend?window=3');
    expect(trend.map((p) => p.month)).toEqual(['2026-04', '2026-05', '2026-06']);
  });
});

describe('category trend', () => {
  it(`charts the ${TOP_SPENDING_CATEGORIES} biggest categories and collapses the tail into one band`, async () => {
    // The fixture only ever categorizes Groceries and Subscriptions — everything
    // else is Uncategorized — so there is no tail to collapse until one exists.
    // Seven categories, descending, puts two of them below the cut.
    const descending = [
      ['Housing', -700_00],
      ['Groceries', -600_00],
      ['Transport', -500_00],
      ['Utilities', -400_00],
      ['Health', -300_00],
      ['Shopping', -200_00],
      ['Travel', -100_00],
    ] as const;

    descending.forEach(([name, amountCents], i) => {
      const category = db.select().from(categories).where(eq(categories.name, name)).get()!;
      db.insert(transactions)
        .values({
          accountId: 1,
          paymentDate: '2026-05-10',
          bookingDate: '2026-05-10',
          amountCents,
          type: 'KORTTIOSTO',
          counterparty: `TOP N GUARD ${name}`,
          contentHash: `top-n-guard-${i}`,
          categoryId: category.id,
          categorySource: 'manual',
        })
        .run();
    });

    const trend = await get<CategoryTrend>('/api/dashboard/category-trend?window=12');
    const named = trend.series.filter((s) => s.key !== 'rest' && s.key !== null);
    expect(named).toHaveLength(TOP_SPENDING_CATEGORIES);

    // The ranking rule itself: descending total over the window's COMPLETE
    // months. Derived from the per-month endpoint rather than hardcoded, since
    // the fixture's own spend contributes to these categories too.
    const totals = new Map<number, { name: string; total: number }>();
    for (const { month, partial } of trend.months) {
      if (partial) continue;
      const breakdown = await get<CategoryBreakdownEntry[]>(
        `/api/dashboard/categories?month=${month}`,
      );
      for (const entry of breakdown) {
        if (entry.categoryId === null) continue;
        const current = totals.get(entry.categoryId);
        if (current) current.total += entry.amountCents;
        else totals.set(entry.categoryId, { name: entry.name, total: entry.amountCents });
      }
    }
    const expectedTop = [...totals.values()]
      .sort((a, b) => b.total - a.total)
      .slice(0, TOP_SPENDING_CATEGORIES)
      .map((c) => c.name);
    expect(named.map((s) => s.name)).toEqual(expectedTop);

    // Travel was the smallest and has no fixture spend, so it fell below the cut
    // and is inside the remainder rather than charted or dropped.
    expect(expectedTop).not.toContain('Travel');
    const rest = trend.series.find((s) => s.key === 'rest');
    expect(rest).toBeDefined();
    const may = trend.months.findIndex((m) => m.month === '2026-05');
    expect(rest!.amountsCents[may]).toBeGreaterThanOrEqual(100_00);
  });

  it('drops the remainder band entirely when the top few are the whole picture', async () => {
    // The untouched fixture has only two categorized expense categories, so a
    // collapsed band would be a row of zeros — clutter, not information.
    const trend = await get<CategoryTrend>('/api/dashboard/category-trend?window=12');
    expect(trend.series.some((s) => s.key === 'rest')).toBe(false);
  });

  it('keeps Uncategorized as its own series, never collapsed into the remainder', async () => {
    const trend = await get<CategoryTrend>('/api/dashboard/category-trend?window=12');
    const uncategorized = trend.series.find((s) => s.key === null);
    expect(uncategorized).toBeDefined();
    expect(uncategorized!.name).toBe('Uncategorized');
    expect(uncategorized!.amountsCents.some((n) => n !== 0)).toBe(true);
  });

  it('every series covers every month, and the stack sums to the per-month breakdown', async () => {
    const trend = await get<CategoryTrend>('/api/dashboard/category-trend?window=12');

    for (const s of trend.series) {
      expect(s.amountsCents, String(s.key)).toHaveLength(trend.months.length);
    }

    for (const [i, { month }] of trend.months.entries()) {
      const breakdown = await get<CategoryBreakdownEntry[]>(
        `/api/dashboard/categories?month=${month}`,
      );
      const expected = breakdown.reduce((sum, e) => sum + e.amountCents, 0);
      const stacked = trend.series.reduce((sum, s) => sum + s.amountsCents[i]!, 0);
      expect(stacked, month).toBe(expected);
    }
  });

  it('ranks on complete months only, so the month in progress cannot reshuffle the legend', async () => {
    const before = await get<CategoryTrend>('/api/dashboard/category-trend?window=12');
    const rankingBefore = before.series.map((s) => String(s.key));

    // Pile a large expense into the CURRENT (partial) month, in a category that
    // is otherwise nowhere near the top. Ranking must ignore it.
    const subscriptions = db
      .select()
      .from(categories)
      .where(eq(categories.name, 'Subscriptions'))
      .get()!;
    db.insert(transactions)
      .values({
        accountId: 1,
        paymentDate: `${CURRENT_MONTH}-10`,
        bookingDate: `${CURRENT_MONTH}-10`,
        amountCents: -900_000,
        type: 'KORTTIOSTO',
        counterparty: 'BIG PARTIAL MONTH SPEND',
        contentHash: 'partial-rank-guard',
        categoryId: subscriptions.id,
        categorySource: 'manual',
      })
      .run();

    const after = await get<CategoryTrend>('/api/dashboard/category-trend?window=12');
    expect(after.series.map((s) => String(s.key))).toEqual(rankingBefore);
  });
});

describe('budget trend', () => {
  it('reports the same totals the per-month card does', async () => {
    const trend = await get<BudgetTrendPoint[]>('/api/dashboard/budget-trend?window=12');

    for (const point of trend) {
      const card = await get<BudgetVsActual>(`/api/dashboard/budget-vs-actual?month=${point.month}`);
      expect(point.plannedCents, point.month).toBe(card.totals.plannedCents);
      expect(point.actualCents, point.month).toBe(card.totals.actualCents);
      expect(point.expenseCents, point.month).toBe(card.totals.expenseCents);
      expect(point.materialized, point.month).toBe(card.materialized);
    }
  });

  it('ties out to cash flow month by month', async () => {
    const [budget, cash] = await Promise.all([
      get<BudgetTrendPoint[]>('/api/dashboard/budget-trend?window=12'),
      get<CashFlowPoint[]>('/api/dashboard/cash-flow?window=12'),
    ]);

    for (const point of budget) {
      const month = cash.find((c) => c.month === point.month)!;
      expect(point.expenseCents, point.month).toBe(month.expensesCents);
    }
  });

  it('never materializes a budget month as a side effect of being charted', async () => {
    const before = db.select().from(transactions).all().length;
    await get<BudgetTrendPoint[]>('/api/dashboard/budget-trend?window=12');
    const trend = await get<BudgetTrendPoint[]>('/api/dashboard/budget-trend?window=12');

    // No fixture month is materialized, and reading twice must not change that.
    expect(trend.every((p) => !p.materialized)).toBe(true);
    expect(db.select().from(transactions).all().length).toBe(before);
  });
});
