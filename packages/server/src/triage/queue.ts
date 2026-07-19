import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { TriageGroup, TriageGroupApply, TriageQueue, TriageUndoResult } from '@finance/shared';
import type { Db } from '../db/client';
import { categories, labelingRules, transactions } from '../db/schema';
import { normalizeCounterparty } from '../import/normalize';

/**
 * Triage: draining the backlog of committed transactions still carrying
 * `category_id is null`, which is where rows land when an import is committed
 * with `allowUncategorized`.
 *
 * Grouping recomputes `normalizeCounterparty` per row rather than reading a
 * stored column — `transactions` has none, unlike `staged_transactions`. That
 * is deliberate: `BRAND_KEYS` is intended to become user-editable, and a stored
 * normalization would need a full recompute on every edit to stay honest.
 * Calling the same pure function both here and at import time is what keeps the
 * two paths from disagreeing about what counts as the same counterparty.
 */

export class TriageError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

/** What `undoTriageApply` needs to reverse one apply. */
export type TriageUndoRecord = {
  transactionIds: number[];
  categoryId: number;
  categorySource: 'manual' | 'rule';
  ruleId: number | null;
};

export function listTriageQueue(db: Db): TriageQueue {
  const rows = db
    .select()
    .from(transactions)
    .where(isNull(transactions.categoryId))
    .orderBy(desc(transactions.paymentDate), desc(transactions.id))
    .all();

  const ruleByKey = new Map(
    db
      .select()
      .from(labelingRules)
      .all()
      .map((r) => [r.normalizedCounterparty, r] as const),
  );

  const byKey = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = normalizeCounterparty(row.counterparty);
    const bucket = byKey.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      byKey.set(key, [row]);
    }
  }

  const groups: TriageGroup[] = [...byKey].map(([key, groupRows]) => {
    const rule = ruleByKey.get(key);
    return {
      normalizedCounterparty: key,
      exampleRaw: groupRows[0]!.counterparty,
      count: groupRows.length,
      totalAmountCents: groupRows.reduce((sum, r) => sum + r.amountCents, 0),
      existingRule: rule ? { id: rule.id, categoryId: rule.categoryId } : null,
      rows: groupRows.map((r) => ({
        id: r.id,
        paymentDate: r.paymentDate,
        amountCents: r.amountCents,
        counterparty: r.counterparty,
        note: r.note,
      })),
    };
  });

  // Biggest wins first. Amounts are signed (expenses negative), so magnitude —
  // not value — is what ranks two groups of equal size.
  groups.sort(
    (a, b) =>
      b.count - a.count ||
      Math.abs(b.totalAmountCents) - Math.abs(a.totalAmountCents) ||
      a.normalizedCounterparty.localeCompare(b.normalizedCounterparty),
  );

  return { totalCount: rows.length, groups };
}

export function countUncategorized(db: Db): number {
  const [row] = db
    .select({ n: count() })
    .from(transactions)
    .where(isNull(transactions.categoryId))
    .all();
  return row?.n ?? 0;
}

/**
 * Apply one category to every uncategorized row sharing a normalized
 * counterparty.
 *
 * Triage only ever INSERTs a labeling rule, never UPDATEs one: rewriting a rule
 * also retroactively relabels rule-sourced rows outside this view, and that
 * blast radius belongs on the Rules screen where it is visible. Both ways of
 * reaching an update are 409s here, so no UI path can bypass the restriction.
 */
export function applyTriageGroup(
  db: Db,
  input: TriageGroupApply,
): { appliedCount: number; source: 'manual' | 'rule'; undo: TriageUndoRecord } {
  const [category] = db.select().from(categories).where(eq(categories.id, input.categoryId)).all();
  if (!category) {
    throw new TriageError('category not found', 404);
  }

  const key = input.normalizedCounterparty;
  const [existingRule] = db
    .select()
    .from(labelingRules)
    .where(eq(labelingRules.normalizedCounterparty, key))
    .all();

  if (existingRule && input.rememberRule) {
    throw new TriageError(
      'a labeling rule already exists for this counterparty — change it on the Rules screen',
      409,
    );
  }
  if (existingRule && existingRule.categoryId !== input.categoryId) {
    throw new TriageError(
      'a labeling rule sends this counterparty to a different category — change it on the Rules screen, or categorize these transactions one at a time',
      409,
    );
  }

  const matching = db
    .select()
    .from(transactions)
    .where(isNull(transactions.categoryId))
    .all()
    .filter((t) => normalizeCounterparty(t.counterparty) === key);
  if (matching.length === 0) {
    throw new TriageError('no uncategorized transactions match this counterparty', 409);
  }
  const ids = matching.map((t) => t.id);

  // `rule` iff a labeling rule now maps this key to the chosen category — the
  // one just created, or the one already there. Writing `manual` instead would
  // be the tempting shortcut and would permanently exempt these rows from any
  // later correction to that rule (decision 002-A: manual always wins).
  const source = input.rememberRule || existingRule ? ('rule' as const) : ('manual' as const);

  const ruleId = db.transaction((tx) => {
    let created: number | null = null;
    if (input.rememberRule) {
      created = tx
        .insert(labelingRules)
        .values({
          normalizedCounterparty: key,
          categoryId: input.categoryId,
          exampleRaw: matching[0]!.counterparty,
        })
        .returning()
        .get().id;
    }
    tx.update(transactions)
      .set({ categoryId: input.categoryId, categorySource: source, updatedAt: new Date() })
      .where(inArray(transactions.id, ids))
      .run();
    return created;
  });

  return {
    appliedCount: ids.length,
    source,
    undo: { transactionIds: ids, categoryId: input.categoryId, categorySource: source, ruleId },
  };
}

export function undoTriageApply(db: Db, undo: TriageUndoRecord): TriageUndoResult {
  return db.transaction((tx) => {
    // Only rows still holding exactly what the apply wrote. A row edited again
    // since is a newer decision by the user and must not be clobbered.
    const restorable = tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          inArray(transactions.id, undo.transactionIds),
          eq(transactions.categoryId, undo.categoryId),
          eq(transactions.categorySource, undo.categorySource),
        ),
      )
      .all()
      .map((t) => t.id);

    if (restorable.length > 0) {
      tx.update(transactions)
        .set({ categoryId: null, categorySource: null, updatedAt: new Date() })
        .where(inArray(transactions.id, restorable))
        .run();
    }
    if (undo.ruleId !== null) {
      tx.delete(labelingRules).where(eq(labelingRules.id, undo.ruleId)).run();
    }
    return { restoredCount: restorable.length, ruleDeleted: undo.ruleId !== null };
  });
}
