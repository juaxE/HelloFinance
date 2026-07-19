import type { FastifyInstance } from 'fastify';
import { zMonthQuery, zTrendQuery } from '@finance/shared';
import type { Db } from '../db/client';
import {
  cashFlow,
  categoryBreakdown,
  categoryTrend,
  incomeBreakdown,
  incomeTrend,
  recurringCommitments,
  trendMonths,
} from '../dashboard/aggregates';
import { budgetTrend, budgetVsActual } from '../dashboard/budget-vs-actual';
import { netWorthTrend } from '../dashboard/net-worth';

/**
 * Dashboard read endpoints (spec 004). Every one of them is a pure read: the
 * dashboard must never materialize a budget month or write anything as a side
 * effect of being looked at (decision 003-C).
 *
 * The flow aggregates come in two shapes. The `?month=` forms are the per-month
 * primitives — that is where criterion 5's tie-out to `reconcileMonth` is
 * asserted — and the `-trend` forms compose them across a window. The dashboard
 * charts the trends: a flow read for the month in progress is an incomplete
 * period, not a small one, and reading it beside finished months invites
 * exactly the wrong conclusion.
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
    return cashFlow(db, trendMonths(db, parsed.data, currentMonth()), currentMonth());
  });

  app.get('/api/dashboard/income', async (req, reply) => {
    const parsed = zMonthQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }
    return incomeBreakdown(db, parsed.data.month);
  });

  app.get('/api/dashboard/income-trend', async (req, reply) => {
    const parsed = zTrendQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }
    return incomeTrend(db, trendMonths(db, parsed.data, currentMonth()), currentMonth());
  });

  app.get('/api/dashboard/categories', async (req, reply) => {
    const parsed = zMonthQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }
    return categoryBreakdown(db, parsed.data.month);
  });

  app.get('/api/dashboard/category-trend', async (req, reply) => {
    const parsed = zTrendQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }
    return categoryTrend(db, trendMonths(db, parsed.data, currentMonth()), currentMonth());
  });

  app.get('/api/dashboard/budget-vs-actual', async (req, reply) => {
    const parsed = zMonthQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }
    return budgetVsActual(db, parsed.data.month);
  });

  app.get('/api/dashboard/budget-trend', async (req, reply) => {
    const parsed = zTrendQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }
    return budgetTrend(db, trendMonths(db, parsed.data, currentMonth()), currentMonth());
  });

  app.get('/api/dashboard/recurring-commitments', async () => recurringCommitments(db, currentMonth()));
}
