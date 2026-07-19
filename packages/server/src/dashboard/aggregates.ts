/**
 * Dashboard aggregates (spec 004). Every figure is recomputed from committed
 * `transactions` on read — nothing is stored — so the dashboard cannot drift
 * from the transaction list or the budget month view.
 *
 * The three-bucket split (decision 004-A) is the single rule underneath all of
 * them, and it is CATEGORY-driven, never sign-driven:
 *   - Transfer   (`system_key='transfer'`) — excluded from every aggregate;
 *   - income     (`is_income_source`)      — counts as income;
 *   - expense    (everything else, INCLUDING `category_id is null`).
 *
 * A positive amount in an expense category is therefore a reimbursement, and it
 * nets that category down rather than appearing as income (a split €40 dinner
 * with €20 paid back leaves Restaurants at €20).
 *
 * All arithmetic is integer cents (CLAUDE.md non-negotiable #3). The ONLY
 * division in the file is `normalizedMonthlyCents`, a display-only planning
 * indicator whose rounding is pinned by decision 003-E.
 */

import { and, gte, lte } from 'drizzle-orm';
import type { Db } from '../db/client';
import { accounts, categories, recurringTemplates, transactions } from '../db/schema';
import { addMonths, monthDateRange } from '../budgets/months';
import type {
  CashFlowPoint,
  CategoryBreakdownEntry,
  IncomeBreakdown,
  RecurringCommitments,
  TrendQuery,
} from '@finance/shared';

type TransactionRow = typeof transactions.$inferSelect;
type CategoryRow = typeof categories.$inferSelect;

/**
 * Which bucket each category falls in. Resolved once per request and passed
 * around, so a single query backs every classification in one response.
 */
export type Buckets = {
  transferIds: Set<number>;
  incomeIds: Set<number>;
  byId: Map<number, CategoryRow>;
};

export function loadBuckets(db: Db): Buckets {
  const rows = db.select().from(categories).all();
  return {
    transferIds: new Set(rows.filter((c) => c.systemKey === 'transfer').map((c) => c.id)),
    incomeIds: new Set(rows.filter((c) => c.isIncomeSource).map((c) => c.id)),
    byId: new Map(rows.map((c) => [c.id, c])),
  };
}

/** Uncategorized rows are expense (they are spending that has not been reviewed yet). */
function isExpense(t: TransactionRow, b: Buckets): boolean {
  if (t.categoryId === null) return true;
  return !b.transferIds.has(t.categoryId) && !b.incomeIds.has(t.categoryId);
}

function isIncome(t: TransactionRow, b: Buckets): boolean {
  return t.categoryId !== null && b.incomeIds.has(t.categoryId);
}

/** Every transaction in a month, across all accounts (spending is spending). */
export function transactionsInMonth(db: Db, month: string): TransactionRow[] {
  const { start, end } = monthDateRange(month);
  return db
    .select()
    .from(transactions)
    .where(and(gte(transactions.paymentDate, start), lte(transactions.paymentDate, end)))
    .all();
}

// --- Trend window (decisions 004-C, 004-E) ----------------------------------

/**
 * The month containing the earliest `opening_balance_date`, or `null` when the
 * trend must NOT be clamped.
 *
 * A null `opening_balance_date` means the account has no lower bound and
 * contributes in every month (decision 004-E), so a single such account makes
 * every requested month meaningful and suppresses the clamp entirely.
 */
export function clampMonth(db: Db): string | null {
  const rows = db.select().from(accounts).all();
  if (rows.length === 0) return null;
  if (rows.some((a) => a.openingBalanceDate === null)) return null;
  const earliest = rows.map((a) => a.openingBalanceDate!).sort()[0]!;
  return earliest.slice(0, 7);
}

/**
 * The months a trend request covers, oldest first: a `window` counted back from
 * the current month, or an explicit `from`/`to`, then clamped at the start to
 * the earliest opening month. A window reaching further back simply returns
 * FEWER points — never a flat line painted backwards over months that have no
 * records (decision 004-E). An empty array is a legitimate answer.
 */
export function trendMonths(db: Db, query: TrendQuery, currentMonth: string): string[] {
  const to = query.to ?? currentMonth;
  const from = query.from ?? addMonths(to, -((query.window ?? 12) - 1));

  const clamp = clampMonth(db);
  const start = clamp !== null && clamp > from ? clamp : from;

  const months: string[] = [];
  for (let m = start; m <= to; m = addMonths(m, 1)) months.push(m);
  return months;
}

// --- Cash flow --------------------------------------------------------------

/**
 * Income and expenses per month, transfers excluded on both sides.
 *
 * `expensesCents` is a positive magnitude (`Σ −amount`), which is what lets a
 * reimbursement reduce it: the row is signed, so it subtracts. This is the same
 * figure spec 003's reconciliation reports as `totals.expenseCents` over the
 * same month, and criteria 2 and 5 assert that equality.
 */
export function cashFlow(db: Db, months: string[]): CashFlowPoint[] {
  const buckets = loadBuckets(db);
  return months.map((month) => {
    const rows = transactionsInMonth(db, month);
    const incomeCents = rows
      .filter((t) => isIncome(t, buckets))
      .reduce((s, t) => s + t.amountCents, 0);
    const expensesCents = rows
      .filter((t) => isExpense(t, buckets))
      .reduce((s, t) => s - t.amountCents, 0);
    return { month, incomeCents, expensesCents, netCents: incomeCents - expensesCents };
  });
}

// --- Income sources (decision 004-A) ----------------------------------------

/**
 * Salary vs other income for a month. Salary is the `Income` built-in (PALKKA
 * auto-labels there via the type hint); every other income-source category is
 * "other income". Reimbursements are deliberately absent — they are not income,
 * and surface as negative offsets inside the category breakdown instead.
 */
export function incomeBreakdown(db: Db, month: string): IncomeBreakdown {
  const buckets = loadBuckets(db);
  const rows = transactionsInMonth(db, month).filter((t) => isIncome(t, buckets));

  const byCategoryId = new Map<number, number>();
  for (const t of rows) {
    byCategoryId.set(t.categoryId!, (byCategoryId.get(t.categoryId!) ?? 0) + t.amountCents);
  }

  let salaryCents = 0;
  let otherIncomeCents = 0;
  const byCategory = [...byCategoryId].map(([categoryId, amountCents]) => {
    const category = buckets.byId.get(categoryId)!;
    if (category.systemKey === 'income') salaryCents += amountCents;
    else otherIncomeCents += amountCents;
    return { categoryId, name: category.name, amountCents };
  });
  byCategory.sort((a, b) => b.amountCents - a.amountCents);

  return { month, salaryCents, otherIncomeCents, byCategory };
}

// --- Category breakdown (decision 003-M) ------------------------------------

/**
 * Per-category expense magnitudes for a month, biggest first, with
 * Uncategorized (`categoryId: null`) as its own entry.
 *
 * Attribution is by the TRANSACTION'S OWN category — deliberately diverging
 * from spec 003's month view, which attributes a named line's matched amount to
 * the LINE's category (decision 003-G). This chart answers "where did the money
 * go"; 003 answers "how did my plan do". They therefore disagree per category
 * after a relabel while their month TOTALS stay equal, which is exactly what
 * criterion 7 pins. Do not "reconcile" this by adopting 003's attribution: the
 * spending chart would then move whenever a budget line is added or
 * re-categorized — reporting mutated by planning configuration.
 */
export function categoryBreakdown(db: Db, month: string): CategoryBreakdownEntry[] {
  const buckets = loadBuckets(db);
  const rows = transactionsInMonth(db, month).filter((t) => isExpense(t, buckets));

  const totals = new Map<number | null, number>();
  for (const t of rows) {
    totals.set(t.categoryId, (totals.get(t.categoryId) ?? 0) - t.amountCents);
  }

  return [...totals]
    .map(([categoryId, amountCents]) => {
      const category = categoryId === null ? undefined : buckets.byId.get(categoryId);
      return {
        categoryId,
        name: category?.name ?? 'Uncategorized',
        color: category?.color ?? null,
        amountCents,
      };
    })
    .sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents));
}

// --- Normalized monthly commitments (decision 003-E) ------------------------

/**
 * `round(amount_cents / interval_months)`, **half-up away from zero**, on the
 * cent — pinned by decision 003-E so the figure is reproducible rather than
 * whatever the platform's default happens to be.
 *
 * Computed with integer arithmetic: `floor((2·|n| + d) / 2d)` is the half-up
 * quotient, and the sign is reapplied afterwards so the rounding is away from
 * zero on both sides. 1233/2 → 617 (the exact half rounds up), 100000/12 → 8333.
 */
export function roundHalfUpAwayFromZero(numerator: number, denominator: number): number {
  const sign = numerator < 0 ? -1 : 1;
  const magnitude = Math.floor((2 * Math.abs(numerator) + denominator) / (2 * denominator));
  return sign * magnitude;
}

/**
 * The read-only planning indicator: what the active recurring bills cost per
 * month once non-monthly cadences are smoothed (a 600 €/yr insurance is ~50 €/mo).
 *
 * "Active this month" is `start_month <= month <= end_month` (end open ⇒
 * ongoing) — NOT "due this month", so the figure is identical in every month
 * regardless of which charge actually lands. Rounding is per template, before
 * summing. This never enters budgets, reconciliation or net worth: those use
 * real transactions, which is why rounding to whole cents here is harmless.
 */
export function recurringCommitments(db: Db, month: string): RecurringCommitments {
  const active = db
    .select()
    .from(recurringTemplates)
    .all()
    .filter((t) => t.startMonth <= month && (t.endMonth === null || month <= t.endMonth));

  const byTemplate = active.map((t) => ({
    templateId: t.id,
    name: t.name,
    amountCents: t.amountCents,
    intervalMonths: t.intervalMonths,
    monthlyEquivalentCents: roundHalfUpAwayFromZero(t.amountCents, t.intervalMonths),
  }));

  return {
    month,
    normalizedMonthlyCents: byTemplate.reduce((s, t) => s + t.monthlyEquivalentCents, 0),
    byTemplate,
  };
}
