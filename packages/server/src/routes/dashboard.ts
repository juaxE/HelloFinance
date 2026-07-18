import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { zMonthQuery, zTrendQuery, type BudgetVsActual } from '@finance/shared';
import type { Db } from '../db/client';
import { budgets } from '../db/schema';
import { reconcileMonth, selectM } from '../budgets/reconcile';
import {
  cashFlow,
  categoryBreakdown,
  incomeBreakdown,
  recurringCommitments,
  trendMonths,
} from '../dashboard/aggregates';
import { netWorthTrend } from '../dashboard/net-worth';

/**
 * Dashboard read endpoints (spec 004). Every one of them is a pure read: the
 * dashboard must never materialize a budget month or write anything as a side
 * effect of being looked at (decision 003-C).
 */
export function registerDashboardRoutes(
  app: FastifyInstance,
  db: Db,
  currentMonth: () => string,
): void {
  /**
   * The net-worth trend. Ignores `archived_at` entirely (decision 004-F): an
   * archived asset's snapshots keep carrying forward, because history must not
   * change because of an action taken today.
   */
  app.get('/api/dashboard/net-worth', async (req, reply) => {
    const parsed = zTrendQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }
    return netWorthTrend(db, trendMonths(db, parsed.data, currentMonth()));
  });

  app.get('/api/dashboard/cash-flow', async (req, reply) => {
    const parsed = zTrendQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }
    return cashFlow(db, trendMonths(db, parsed.data, currentMonth()));
  });

  app.get('/api/dashboard/income', async (req, reply) => {
    const parsed = zMonthQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }
    return incomeBreakdown(db, parsed.data.month);
  });

  app.get('/api/dashboard/categories', async (req, reply) => {
    const parsed = zMonthQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }
    return categoryBreakdown(db, parsed.data.month);
  });

  /**
   * Planned vs actual, **delegated to spec 003's `reconcileMonth`** — there is
   * no parallel implementation here, so the card and the Budgets month view can
   * never report different totals (criterion 5).
   *
   * An unmaterialized month reports `materialized: false` rather than being
   * created on a glance. Its `expenseCents` is still real (computed over 003's
   * same set M), so the tie-out to cash flow holds either way; the planned side
   * is simply empty, which is the truth about a month with no budget.
   */
  app.get('/api/dashboard/budget-vs-actual', async (req, reply) => {
    const parsed = zMonthQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }
    const { month } = parsed.data;

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
      } satisfies BudgetVsActual;
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
    } satisfies BudgetVsActual;
  });

  app.get('/api/dashboard/recurring-commitments', async () => recurringCommitments(db, currentMonth()));
}
