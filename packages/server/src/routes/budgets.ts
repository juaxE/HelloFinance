import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { zBudgetCreate, zBudgetPatch } from '@finance/shared';
import type { Db } from '../db/client';
import { budgetLines, budgets } from '../db/schema';
import { materializeMonth } from '../budgets/materialize';
import { serializeBudgetLine } from './serialize';

/**
 * Budget months (spec 003). Materialization creates **recurring lines only** —
 * envelopes are never auto-created (decision 003-K), so a month with zero
 * envelope lines truthfully reports "not budgeted yet".
 */
export function registerBudgetRoutes(app: FastifyInstance, db: Db): void {
  app.post('/api/budgets', async (req, reply) => {
    const parsed = zBudgetCreate.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }
    const { budget, created } = materializeMonth(db, parsed.data.month);
    const lines = await db.select().from(budgetLines).where(eq(budgetLines.budgetId, budget.id));
    // Re-materializing is a no-op rather than an error: the caller asked for the
    // month to exist, and it does. 200 vs 201 distinguishes the two.
    return reply.code(created ? 201 : 200).send({
      month: budget.month,
      budgetId: budget.id,
      note: budget.note,
      lines: lines.map(serializeBudgetLine),
    });
  });

  app.patch('/api/budgets/:month', async (req, reply) => {
    const month = (req.params as { month: string }).month;
    const parsed = zBudgetPatch.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }
    const existing = db.select().from(budgets).where(eq(budgets.month, month)).get();
    if (!existing) {
      return reply.code(404).send({ error: 'budget month not materialized' });
    }
    const row = db
      .update(budgets)
      .set({ note: parsed.data.note })
      .where(eq(budgets.month, month))
      .returning()
      .get();
    return { month: row.month, budgetId: row.id, note: row.note };
  });
}
