import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { zBudgetCreate, zBudgetPatch, zMonth } from '@finance/shared';
import type { Db } from '../db/client';
import { budgetLines, budgets } from '../db/schema';
import { materializeMonth } from '../budgets/materialize';
import { envelopeRelevantCategories, reconcileMonth } from '../budgets/reconcile';
import { previousMonth } from '../budgets/months';
import { serializeBudgetLine } from './serialize';

/**
 * Budget months (spec 003). Materialization creates **recurring lines only** —
 * envelopes are never auto-created (decision 003-K), so a month with zero
 * envelope lines truthfully reports "not budgeted yet".
 */
export function registerBudgetRoutes(app: FastifyInstance, db: Db, currentMonth: () => string): void {
  /**
   * The month with its reconciliation.
   *
   * Auto-materializes the **current** month and any month the caller explicitly
   * opens (`?open=1`); any other absent month returns an uncreated marker rather
   * than being materialized on a glance (decision 003-C). Merely looking at a
   * month must not create it — a materialized month is a commitment (its lines
   * are a historical record, and deletions in it are durable).
   */
  app.get('/api/budgets/:month', async (req, reply) => {
    const month = (req.params as { month: string }).month;
    if (!zMonth.safeParse(month).success) {
      return reply.code(400).send({ error: 'expected YYYY-MM' });
    }
    const explicitlyOpened = (req.query as { open?: string }).open === '1';

    let budget = db.select().from(budgets).where(eq(budgets.month, month)).get();
    if (!budget) {
      if (month !== currentMonth() && !explicitlyOpened) {
        return { month, uncreated: true as const };
      }
      budget = materializeMonth(db, month).budget;
    }

    const reconciliation = reconcileMonth(db, budget.id, month);
    return {
      month: budget.month,
      budgetId: budget.id,
      note: budget.note,
      lines: reconciliation.lines.map((line) => ({
        ...serializeBudgetLine(line),
        actualCents: line.actualCents,
        varianceCents: line.varianceCents,
        pending: line.pending,
      })),
      categories: reconciliation.categories,
      unbudgeted: reconciliation.unbudgeted,
      needsReview: reconciliation.needsReview,
      envelopeCandidates: envelopeCandidates(db, budget.id, month, reconciliation),
      totals: reconciliation.totals,
      // The "did I budget this month?" signal decision 003-K exists to protect.
      budgeted: reconciliation.lines.some((l) => l.kind === 'envelope'),
    };
  });

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

/**
 * One entry per envelope-relevant category, for the budget-making screen.
 *
 * `suggestedAmountCents` is that category's envelope in the **immediately
 * preceding** calendar month — no deeper lookback, so the first month ever is
 * entirely blank. It is **data for rendering, never a line** (decision 003-K):
 * nothing here creates an envelope, because auto-created envelopes would make
 * every month look budgeted and destroy the "did I budget this month?" signal.
 *
 * `plannedSubtotalCents` is `plannedCents(C)` — envelope + named lines in the
 * category — so double-planning (an ad-hoc car-service line *and* a raised
 * Transport envelope) is visible at a glance rather than found at month end.
 */
function envelopeCandidates(
  db: Db,
  budgetId: number,
  month: string,
  reconciliation: ReturnType<typeof reconcileMonth>,
): {
  categoryId: number;
  envelopeAmountCents: number | null;
  suggestedAmountCents: number | null;
  plannedSubtotalCents: number;
}[] {
  const previous = db.select().from(budgets).where(eq(budgets.month, previousMonth(month))).get();
  const previousEnvelopes = previous
    ? new Map(
        db
          .select()
          .from(budgetLines)
          .where(eq(budgetLines.budgetId, previous.id))
          .all()
          .filter((l) => l.kind === 'envelope')
          .map((l) => [l.categoryId, l.amountCents]),
      )
    : new Map<number, number>();

  const lines = db.select().from(budgetLines).where(eq(budgetLines.budgetId, budgetId)).all();
  const envelopes = new Map(
    lines.filter((l) => l.kind === 'envelope').map((l) => [l.categoryId, l.amountCents]),
  );
  const planned = new Map(reconciliation.categories.map((c) => [c.categoryId, c.plannedCents]));

  return envelopeRelevantCategories(db)
    // Archived categories are omitted unless they already have a line in this
    // month, symmetric with what `PUT …/envelopes` will accept.
    .filter((c) => c.archivedAt === null || lines.some((l) => l.categoryId === c.id))
    .map((c) => ({
      categoryId: c.id,
      envelopeAmountCents: envelopes.get(c.id) ?? null,
      suggestedAmountCents: previousEnvelopes.get(c.id) ?? null,
      plannedSubtotalCents: planned.get(c.id) ?? 0,
    }));
}
