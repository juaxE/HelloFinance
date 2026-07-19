import { z } from 'zod';
import { zIsoDate } from './common';

/**
 * Triage: resolving committed transactions that are still Uncategorized
 * (`category_id is null`), which is where rows land when an import is committed
 * with `allowUncategorized`. Grouped by normalized counterparty — the same key
 * `labeling_rules` is keyed on, so a group maps 1:1 onto a candidate rule.
 */

/** One uncategorized transaction inside a triage group. */
export const zTriageRow = z.object({
  id: z.number().int(),
  paymentDate: zIsoDate,
  amountCents: z.number().int(),
  counterparty: z.string(),
  note: z.string().nullable(),
});
export type TriageRow = z.infer<typeof zTriageRow>;

/**
 * Every uncategorized transaction sharing one normalized counterparty.
 *
 * `existingRule` is non-null when a labeling rule already claims this key (the
 * rows predate it). Triage may re-apply that rule to them, but never rewrites
 * it — a different category is a 409, not an upsert.
 */
export const zTriageGroup = z.object({
  normalizedCounterparty: z.string(),
  exampleRaw: z.string(),
  count: z.number().int(),
  totalAmountCents: z.number().int(),
  existingRule: z.object({ id: z.number().int(), categoryId: z.number().int() }).nullable(),
  rows: z.array(zTriageRow),
});
export type TriageGroup = z.infer<typeof zTriageGroup>;

/** Groups sorted by count desc, then by absolute total desc. */
export const zTriageQueue = z.object({
  totalCount: z.number().int(),
  groups: z.array(zTriageGroup),
});
export type TriageQueue = z.infer<typeof zTriageQueue>;

/** The nav badge — cheap enough to poll without building the whole queue. */
export const zTriageCount = z.object({ count: z.number().int() });
export type TriageCount = z.infer<typeof zTriageCount>;

/**
 * Apply one category to every uncategorized row in a group. `rememberRule` also
 * inserts a labeling rule, and is rejected when the key already has one.
 */
export const zTriageGroupApply = z.object({
  normalizedCounterparty: z.string().min(1),
  categoryId: z.number().int(),
  rememberRule: z.boolean(),
});
export type TriageGroupApply = z.infer<typeof zTriageGroupApply>;

/**
 * `source` is what landed in `category_source`: `rule` when a labeling rule now
 * maps this key to the chosen category, `manual` otherwise. Rows written as
 * `rule` still follow a later correction to that rule; `manual` rows never do.
 *
 * `undoToken` feeds `POST /api/transactions/triage/undo`. Only the most recent
 * apply is undoable — the next one invalidates it.
 */
export const zTriageApplyResult = z.object({
  appliedCount: z.number().int(),
  source: z.enum(['manual', 'rule']),
  ruleCreated: z.boolean(),
  undoToken: z.string(),
});
export type TriageApplyResult = z.infer<typeof zTriageApplyResult>;

export const zTriageUndo = z.object({ undoToken: z.string().min(1) });
export type TriageUndo = z.infer<typeof zTriageUndo>;

/**
 * `restoredCount` can be lower than the apply's `appliedCount`: a row edited
 * again after the apply is left alone rather than clobbered.
 */
export const zTriageUndoResult = z.object({
  restoredCount: z.number().int(),
  ruleDeleted: z.boolean(),
});
export type TriageUndoResult = z.infer<typeof zTriageUndoResult>;
