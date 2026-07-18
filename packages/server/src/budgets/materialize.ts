/**
 * Month materialization (spec 003). A month is created on demand — opening it,
 * or `POST /api/budgets` — and creates **recurring lines only**. Envelopes are
 * never auto-created, not from templates, not from the previous month, not from
 * the prefill suggestion (decision 003-K): an envelope exists only because the
 * owner confirmed an amount for that category in that month, which is what makes
 * "does this month have envelopes?" a truthful answer to "did I budget this
 * month?".
 */

import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { budgetLines, budgets, recurringTemplates } from '../db/schema';
import { clampDayToMonth, isTemplateDue } from './months';

type Budget = typeof budgets.$inferSelect;

/**
 * Get the month's budget row, creating it (and its due templates' lines) if it
 * does not exist yet.
 *
 * **Idempotent, and deletion is durable.** If the `budgets` row already exists
 * this is a no-op: lines are not regenerated, so user edits survive and a line
 * the owner deleted for that month stays deleted. That durability is intentional
 * (review Q2), not an accident of the unique index — the month row's existence,
 * not the line set, is what records "this month has been materialized".
 */
export function materializeMonth(db: Db, month: string): { budget: Budget; created: boolean } {
  const existing = db.select().from(budgets).where(eq(budgets.month, month)).get();
  if (existing) {
    return { budget: existing, created: false };
  }

  const budget = db.insert(budgets).values({ month }).returning().get();

  // Template keys are unique across non-ended templates (decision 003-N), and
  // materialization inserts one line per due template — so this loop cannot
  // produce a same-key collision by construction, and needs no collision
  // handling of its own. That is the point of enforcing uniqueness one level up.
  for (const template of db.select().from(recurringTemplates).all()) {
    if (!isTemplateDue(template, month)) continue;
    db.insert(budgetLines).values(snapshotLine(budget.id, template, month)).run();
  }

  return { budget, created: true };
}

/**
 * A template's snapshot for a month: the template's values **as they are now**,
 * frozen onto the line. Later template edits never reach back into an
 * already-materialized month — those lines are a historical record.
 * `amountCents` is the per-occurrence charge, copied as-is with **no division**
 * by the interval (decision 001-H / 003-E).
 */
export function snapshotLine(
  budgetId: number,
  template: typeof recurringTemplates.$inferSelect,
  month: string,
): typeof budgetLines.$inferInsert {
  return {
    budgetId,
    templateId: template.id,
    kind: 'recurring',
    name: template.name,
    categoryId: template.categoryId,
    amountCents: template.amountCents,
    expectedDayOfMonth: clampDayToMonth(template.expectedDayOfMonth, month),
    matchNormalizedCounterparty: template.matchNormalizedCounterparty,
    note: template.note,
  };
}

/** Already-materialized months, for the review-Q1 `addableToMonths` hint. */
export function materializedMonths(db: Db): string[] {
  return db
    .select({ month: budgets.month })
    .from(budgets)
    .all()
    .map((r) => r.month);
}

/** Does this month already hold a line with that match key? (one-per-key invariant) */
export function findLineByMatchKey(
  db: Db,
  budgetId: number,
  matchKey: string,
): typeof budgetLines.$inferSelect | undefined {
  return db
    .select()
    .from(budgetLines)
    .where(
      and(
        eq(budgetLines.budgetId, budgetId),
        eq(budgetLines.matchNormalizedCounterparty, matchKey),
      ),
    )
    .get();
}

/** Does this category already hold an envelope this month? (one-per-category invariant) */
export function findEnvelopeForCategory(
  db: Db,
  budgetId: number,
  categoryId: number,
): typeof budgetLines.$inferSelect | undefined {
  return db
    .select()
    .from(budgetLines)
    .where(
      and(
        eq(budgetLines.budgetId, budgetId),
        eq(budgetLines.kind, 'envelope'),
        eq(budgetLines.categoryId, categoryId),
      ),
    )
    .get();
}
