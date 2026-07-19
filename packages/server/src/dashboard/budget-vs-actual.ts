import { eq } from 'drizzle-orm';
import type { BudgetTrendPoint, BudgetVsActual } from '@finance/shared';
import type { Db } from '../db/client';
import { budgets } from '../db/schema';
import { reconcileMonth, selectM } from '../budgets/reconcile';

/**
 * Planned vs actual for one month, **delegated to spec 003's `reconcileMonth`**
 * — there is no parallel implementation, so this card and the Budgets month
 * view can never report different totals (criterion 5).
 *
 * An unmaterialized month reports `materialized: false` rather than being
 * created on a glance (decision 003-C). Its `expenseCents` is still real
 * (computed over 003's same set M), so the tie-out to cash flow holds either
 * way; the planned side is simply empty, which is the truth about a month with
 * no budget.
 */
export function budgetVsActual(db: Db, month: string): BudgetVsActual {
  const budget = db.select().from(budgets).where(eq(budgets.month, month)).get();
  if (!budget) {
    const expenseCents = selectM(db, month).reduce((s, t) => s - t.amountCents, 0);
    return {
      month,
      materialized: false,
      budgeted: false,
      lines: [],
      totals: {
        plannedCents: 0,
        actualCents: 0,
        unbudgetedCents: 0,
        needsReviewCents: 0,
        expenseCents,
      },
    };
  }

  const reconciliation = reconcileMonth(db, budget.id, month);
  return {
    month,
    materialized: true,
    // The "did I budget this month?" signal decision 003-K exists to protect.
    budgeted: reconciliation.lines.some((l) => l.kind === 'envelope'),
    lines: reconciliation.lines.map((line) => ({
      id: line.id,
      name: line.name,
      categoryId: line.categoryId,
      plannedCents: line.amountCents,
      actualCents: line.actualCents,
      varianceCents: line.varianceCents,
      pending: line.pending,
    })),
    totals: reconciliation.totals,
  };
}

/** The same figures across a window, for the dashboard's budget trend. */
export function budgetTrend(db: Db, months: string[], currentMonth: string): BudgetTrendPoint[] {
  return months.map((month) => {
    const card = budgetVsActual(db, month);
    return {
      month,
      materialized: card.materialized,
      budgeted: card.budgeted,
      plannedCents: card.totals.plannedCents,
      actualCents: card.totals.actualCents,
      expenseCents: card.totals.expenseCents,
      partial: month === currentMonth,
    };
  });
}
