/**
 * Reconciliation: planned vs. actual for a month (spec 003).
 *
 * Actuals are **never stored** — always recomputed from `transactions` by
 * `payment_date` month — so budgets stay correct across re-imports and relabels.
 *
 * The whole computation is a **partition of M** (see `selectM`): every row in M
 * is consumed exactly once, by a named line, by a category envelope, by the
 * unbudgeted bucket, or by needs-review. That is what makes criterion 10's
 * tie-out to spec 004's expense total hold by construction rather than by
 * coincidence.
 *
 * All arithmetic is integer cents (CLAUDE.md non-negotiable #3); no float ever
 * enters this file.
 */

import { and, eq, gte, lte } from 'drizzle-orm';
import type { Db } from '../db/client';
import { budgetLines, categories, transactions } from '../db/schema';
import { normalizeCounterparty } from '../import/normalize';
import { monthDateRange } from './months';

type LineRow = typeof budgetLines.$inferSelect;
type TransactionRow = typeof transactions.$inferSelect;
type CategoryRow = typeof categories.$inferSelect;

export type ReconciledLine = LineRow & {
  actualCents: number;
  varianceCents: number;
  pending: boolean;
};

export type CategoryDecomposition = {
  categoryId: number;
  plannedCents: number;
  actualCents: number;
  envelopePlannedCents: number;
  envelopeActualCents: number;
  namedPlannedCents: number;
  namedActualCents: number;
};

export type NeedsReviewRow = {
  transactionId: number;
  paymentDate: string;
  counterparty: string;
  amountCents: number;
};

export type Reconciliation = {
  lines: ReconciledLine[];
  categories: CategoryDecomposition[];
  unbudgeted: { categoryId: number; actualCents: number }[];
  needsReview: NeedsReviewRow[];
  totals: {
    plannedCents: number;
    actualCents: number;
    unbudgetedCents: number;
    needsReviewCents: number;
    expenseCents: number;
  };
};

/**
 * **M** — the month's transactions in spec 004's expense bucket (decision
 * 003-F). Excludes `Transfer` **and** every `is_income_source` category;
 * **includes** uncategorized rows (`category_id is null`).
 *
 * Both exclusions matter. Leaving income in M would surface the seeded +2826 €
 * PALKKA as "unbudgeted spending" in an expenses-only budget and break the
 * tie-out; dropping uncategorized rows would make them vanish from
 * reconciliation while 004 still counts them as expenses. Spec 004 must compute
 * its expense total over this same set — that pair is where an inconsistency
 * would try to live.
 */
export function selectM(db: Db, month: string): TransactionRow[] {
  const { start, end } = monthDateRange(month);
  const rows = db
    .select()
    .from(transactions)
    .where(and(gte(transactions.paymentDate, start), lte(transactions.paymentDate, end)))
    .all();

  const excluded = new Set(
    db
      .select()
      .from(categories)
      .all()
      .filter((c) => c.systemKey === 'transfer' || c.isIncomeSource)
      .map((c) => c.id),
  );

  return rows.filter((t) => t.categoryId === null || !excluded.has(t.categoryId));
}

/**
 * Expense magnitude of a set of rows: `Σ −amount`. Incoming refunds and
 * paybacks are **signed**, so they net the figure down — the same netting spec
 * 004 sees, which is why the tie-out survives them.
 */
function expenseMagnitude(rows: TransactionRow[]): number {
  return rows.reduce((sum, t) => sum - t.amountCents, 0);
}

export function reconcileMonth(db: Db, budgetId: number, month: string): Reconciliation {
  const lines = db.select().from(budgetLines).where(eq(budgetLines.budgetId, budgetId)).all();
  const m = selectM(db, month);
  const expenseCents = expenseMagnitude(m);

  // Step 1 — named lines consume their counterparty's rows.
  //
  // Matching is strictly within the month: a line never reaches into an
  // adjacent month. A bill that posts late therefore shows twice — pending in
  // its due month, unbudgeted in the month it landed — which makes calendar
  // drift visible instead of letting a number quietly absorb it.
  const namedLines = lines.filter((l) => l.matchNormalizedCounterparty !== null);
  const consumed = new Set<number>();
  const actualByLine = new Map<number, number>();

  for (const line of namedLines) {
    const matched = m.filter(
      (t) =>
        !consumed.has(t.id) &&
        normalizeCounterparty(t.counterparty) === line.matchNormalizedCounterparty,
    );
    for (const t of matched) consumed.add(t.id);
    actualByLine.set(line.id, expenseMagnitude(matched));
  }

  const remaining = m.filter((t) => !consumed.has(t.id));

  // Step 2 — envelopes take their category's remainder.
  //
  // Behavior follows the match key, not `kind` (decision 003-G), so a keyless
  // line reconciles as an envelope whatever its kind says. The API cannot create
  // one (003-J/003-L), but the column is nullable, so a seed script or a future
  // migration could — and two keyless lines in one category would BOTH take the
  // full remainder, double-counting `actualCents` and breaking the tie-out. A
  // broken tie-out is a critical finding, so refuse to report a number instead.
  const keylessNonEnvelope = lines.find(
    (l) => l.matchNormalizedCounterparty === null && l.kind !== 'envelope',
  );
  if (keylessNonEnvelope) {
    throw new Error(
      `budget line ${keylessNonEnvelope.id} (kind=${keylessNonEnvelope.kind}) has no match key; ` +
        `only envelopes may be keyless (decisions 003-J, 003-L)`,
    );
  }

  const envelopeLines = lines.filter((l) => l.matchNormalizedCounterparty === null);
  const envelopeByCategory = new Map(envelopeLines.map((l) => [l.categoryId, l]));
  for (const line of envelopeLines) {
    const rows = remaining.filter((t) => t.categoryId === line.categoryId);
    actualByLine.set(line.id, expenseMagnitude(rows));
  }

  // Step 3 — categorized remainder in a category with no ENVELOPE is unbudgeted.
  // Keyed on the absence of an envelope, NOT of any line: a category holding only
  // a named line (a Spotify line in Subscriptions) would otherwise count as
  // having "a line", and its other remaining spend (a Netflix charge) would fall
  // into no bucket at all — breaking the partition every tie-out rests on. So a
  // category can appear under Unbudgeted while still showing a named line.
  // A category with an explicit 0 envelope HAS an envelope, so it reconciles
  // against that line as overspend and is deliberately NOT unbudgeted.
  const unbudgetedByCategory = new Map<number, number>();
  for (const t of remaining) {
    if (t.categoryId === null) continue;
    if (envelopeByCategory.has(t.categoryId)) continue;
    unbudgetedByCategory.set(
      t.categoryId,
      (unbudgetedByCategory.get(t.categoryId) ?? 0) - t.amountCents,
    );
  }

  // Step 4 — uncategorized remainder belongs to no category, so step 3 cannot
  // cover it. It surfaces as its own bucket with SIGNED amounts: it can hold
  // positive rows (an uncategorized payback) and must not render them as
  // spending.
  const needsReview: NeedsReviewRow[] = remaining
    .filter((t) => t.categoryId === null)
    .map((t) => ({
      transactionId: t.id,
      paymentDate: t.paymentDate,
      counterparty: t.counterparty,
      amountCents: t.amountCents,
    }));

  const reconciledLines: ReconciledLine[] = lines.map((line) => {
    const actualCents = actualByLine.get(line.id) ?? 0;
    const isNamed = line.matchNormalizedCounterparty !== null;
    return {
      ...line,
      actualCents,
      // Both sides are magnitudes: positive variance is underspend.
      varianceCents: line.amountCents - actualCents,
      // Only a named line can be "pending" — planned but not yet seen. An
      // envelope with no spend is simply an envelope at zero actual.
      pending: isNamed && !hasMatch(m, consumed, line),
    };
  });

  return {
    lines: reconciledLines,
    categories: decompose(reconciledLines),
    unbudgeted: [...unbudgetedByCategory].map(([categoryId, actualCents]) => ({
      categoryId,
      actualCents,
    })),
    needsReview,
    totals: {
      plannedCents: lines.reduce((s, l) => s + l.amountCents, 0),
      actualCents: reconciledLines.reduce((s, l) => s + l.actualCents, 0),
      unbudgetedCents: [...unbudgetedByCategory.values()].reduce((s, v) => s + v, 0),
      needsReviewCents: needsReview.reduce((s, r) => s - r.amountCents, 0),
      expenseCents,
    },
  };
}

/**
 * Did this line match anything at all? Distinct from "actual is 0", which a
 * line can also reach by matching a refund that nets its charges to zero.
 */
function hasMatch(m: TransactionRow[], consumed: Set<number>, line: LineRow): boolean {
  return m.some(
    (t) =>
      consumed.has(t.id) &&
      normalizeCounterparty(t.counterparty) === line.matchNormalizedCounterparty,
  );
}

/**
 * Per-category decomposition. Every line carries a required `category_id`, and
 * that category is where both its planned amount and its matched actuals are
 * reported — including for a **named line that matched a transaction labeled
 * elsewhere** (decision 003-G: the line is about the bill, not the category).
 * The consuming line's category wins, and the other category's envelope sees a
 * remainder that excludes the row, so the row is still counted exactly once.
 */
function decompose(lines: ReconciledLine[]): CategoryDecomposition[] {
  const byCategory = new Map<number, CategoryDecomposition>();

  for (const line of lines) {
    const entry = byCategory.get(line.categoryId) ?? {
      categoryId: line.categoryId,
      plannedCents: 0,
      actualCents: 0,
      envelopePlannedCents: 0,
      envelopeActualCents: 0,
      namedPlannedCents: 0,
      namedActualCents: 0,
    };
    const named = line.matchNormalizedCounterparty !== null;
    entry.plannedCents += line.amountCents;
    entry.actualCents += line.actualCents;
    if (named) {
      entry.namedPlannedCents += line.amountCents;
      entry.namedActualCents += line.actualCents;
    } else {
      entry.envelopePlannedCents += line.amountCents;
      entry.envelopeActualCents += line.actualCents;
    }
    byCategory.set(line.categoryId, entry);
  }

  return [...byCategory.values()].sort((a, b) => a.categoryId - b.categoryId);
}

/** Categories a month can hold envelopes for — the same exclusion as M (003-F). */
export function envelopeRelevantCategories(db: Db): CategoryRow[] {
  return db
    .select()
    .from(categories)
    .all()
    .filter((c) => c.systemKey !== 'transfer' && !c.isIncomeSource);
}
