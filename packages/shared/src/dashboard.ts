import { z } from 'zod';
import { zMonth } from './common';

/**
 * Dashboard aggregates (spec 004). Every figure crosses the wire as integer
 * cents; the UI formats at the edge with `formatEur`.
 *
 * The three-bucket split (decision 004-A) governs every aggregate here:
 *   - Transfer (`system_key='transfer'`) — excluded from ALL of them;
 *   - income-source (`is_income_source`) — counts as income;
 *   - expense — everything else, INCLUDING uncategorized (`category_id null`).
 *
 * Income is category-driven, not sign-based, so a positive amount sitting in an
 * expense category is a reimbursement: it nets that category down rather than
 * counting as income.
 */

// --- Trend window (decision 004-C) -----------------------------------------

/** The selectable trend windows, in months, ending at the current month. */
export const TREND_WINDOWS = [3, 6, 9, 12] as const;
export const DEFAULT_TREND_WINDOW = 12;

/**
 * Either a `window` of N months back from the current month, or an explicit
 * `from`/`to`. Both forms are then CLAMPED to the earliest account opening
 * month (decision 004-E) — a window reaching further back returns fewer points
 * rather than padded ones.
 */
export const zTrendQuery = z
  .object({
    // Query params arrive as strings; the enum both validates and pins the set.
    window: z
      .enum(TREND_WINDOWS.map(String) as ['3', '6', '9', '12'])
      .transform(Number)
      .optional(),
    from: zMonth.optional(),
    to: zMonth.optional(),
  })
  .refine((q) => q.window === undefined || (q.from === undefined && q.to === undefined), {
    message: 'pass either window or from/to, not both',
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: 'from must not be after to',
  });
export type TrendQuery = z.infer<typeof zTrendQuery>;

export const zMonthQuery = z.object({ month: zMonth });

// --- Net worth --------------------------------------------------------------

export type NetWorthPoint = {
  month: string;
  /** Every account's balance at month end, buffer/emergency fund included. */
  accountsCents: number;
  /** Latest snapshot with `month <= M` for the investment/other kinds. */
  investmentsCents: number;
  /** Latest snapshot with `month <= M` for loans, POSITIVE; subtracted below. */
  loansCents: number;
  netWorthCents: number;
  /**
   * At least one account was not yet open this month, so it contributed 0
   * (decision 004-E). The chart marks these: the step up when a second account
   * starts being tracked is real and must not read as a windfall.
   */
  partialAccounts: boolean;
};

// --- Cash flow --------------------------------------------------------------

export type CashFlowPoint = {
  month: string;
  incomeCents: number;
  /** A positive magnitude; reimbursement positives net it DOWN. */
  expensesCents: number;
  netCents: number;
  /** See `partial` below — the current month is still accumulating. */
  partial: boolean;
};

// --- Flow trends ------------------------------------------------------------

/**
 * A flow aggregate accumulates OVER a period, so the month in progress is not a
 * smaller version of a finished one — it is an incomplete one, and showing it
 * beside complete months as though it were comparable is a lie. Every flow
 * trend therefore marks it `partial`, and the UI must render it distinctly and
 * keep it out of any headline figure.
 *
 * Net worth carries no such flag on purpose: a balance is a STOCK and is a
 * complete answer at any instant. `NetWorthPoint.partialAccounts` means
 * something else entirely (an account was not open yet).
 */
export type IncomePoint = {
  month: string;
  salaryCents: number;
  otherIncomeCents: number;
  partial: boolean;
};

/** How many categories the spending trend charts before collapsing the rest. */
export const TOP_SPENDING_CATEGORIES = 5;

export type CategoryTrendSeries = {
  /** A category id, `null` for Uncategorized, `'rest'` for the collapsed remainder. */
  key: number | null | 'rest';
  name: string;
  color: string | null;
  /** One positive magnitude per entry in `months`, same order. */
  amountsCents: number[];
};

export type CategoryTrend = {
  months: { month: string; partial: boolean }[];
  /**
   * The largest `TOP_SPENDING_CATEGORIES` over the window's COMPLETE months,
   * then `rest`. Uncategorized is always its own series and is never ranked or
   * collapsed — it is the needs-review signal, not a small category.
   */
  series: CategoryTrendSeries[];
};

export type BudgetTrendPoint = {
  month: string;
  materialized: boolean;
  budgeted: boolean;
  plannedCents: number;
  actualCents: number;
  /** Ties out to the cash-flow endpoint's `expensesCents` for the month. */
  expenseCents: number;
  partial: boolean;
};

// --- Income sources ---------------------------------------------------------

export type IncomeBreakdown = {
  month: string;
  /** The `Income` built-in — PALKKA auto-labels here via the type hint. */
  salaryCents: number;
  /** Every other income-source category. */
  otherIncomeCents: number;
  byCategory: { categoryId: number; name: string; amountCents: number }[];
};

// --- Category breakdown -----------------------------------------------------

export type CategoryBreakdownEntry = {
  /** `null` is Uncategorized — its own slice, marked "needs review" in the UI. */
  categoryId: number | null;
  name: string;
  color: string | null;
  /** Positive magnitude; can go negative in a reimbursement-heavy category. */
  amountCents: number;
};

// --- Budget vs actual -------------------------------------------------------

export type BudgetVsActual = {
  month: string;
  /**
   * False when the month has no budget row. The dashboard never materializes
   * one as a side effect of being looked at (decision 003-C), so the card
   * reports the absence instead of creating the month.
   */
  materialized: boolean;
  /** False when the month holds no envelope — "not budgeted yet" (003-K). */
  budgeted: boolean;
  lines: {
    id: number;
    name: string;
    categoryId: number;
    plannedCents: number;
    actualCents: number;
    varianceCents: number;
    pending: boolean;
  }[];
  totals: {
    plannedCents: number;
    actualCents: number;
    unbudgetedCents: number;
    needsReviewCents: number;
    /** Ties out to the cash-flow endpoint's `expensesCents` for the month. */
    expenseCents: number;
  };
};

// --- Recurring commitments (decision 003-E) ---------------------------------

export type RecurringCommitments = {
  month: string;
  /** Σ over templates active this month of round(amount / interval), half-up per template. */
  normalizedMonthlyCents: number;
  byTemplate: {
    templateId: number;
    name: string;
    amountCents: number;
    intervalMonths: number;
    monthlyEquivalentCents: number;
  }[];
};
