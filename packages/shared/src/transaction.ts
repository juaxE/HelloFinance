import { z } from 'zod';
import { zEpochMs, zIsoDate } from './common';

/**
 * How a transaction's category was assigned (spec 001 + decision 002-A).
 * 'manual' always wins over 'rule'/'type_hint'.
 */
export const CATEGORY_SOURCES = ['manual', 'rule', 'type_hint'] as const;
export const zCategorySource = z.enum(CATEGORY_SOURCES);
export type CategorySource = z.infer<typeof zCategorySource>;

/** API response shape (timestamps are epoch-ms). */
export const zTransaction = z.object({
  id: z.number().int(),
  accountId: z.number().int(),
  paymentDate: zIsoDate,
  bookingDate: zIsoDate,
  amountCents: z.number().int(),
  type: z.string(),
  payer: z.string().nullable(),
  payee: z.string().nullable(),
  counterparty: z.string(),
  counterpartyIban: z.string().nullable(),
  reference: z.string().nullable(),
  message: z.string().nullable(),
  archiveId: z.string().nullable(),
  categoryId: z.number().int().nullable(),
  categorySource: zCategorySource.nullable(),
  note: z.string().nullable(),
  importId: z.number().int().nullable(),
  createdAt: zEpochMs,
  updatedAt: zEpochMs,
});
export type Transaction = z.infer<typeof zTransaction>;

/**
 * Relabel / annotate a committed transaction (spec 002 "Relabeling").
 * `scope` is required whenever `categoryId` is set: `one_off` sets the
 * category for this row only; `update_rule` also upserts the labeling rule
 * for this transaction's normalized counterparty. `note` is independent of
 * category and never needs a scope.
 */
export const zTransactionPatch = z
  .object({
    /**
     * `null` sends the row back to **Uncategorized**, re-queueing it for triage.
     * Only legal with `one_off`: a labeling rule must name a category, so there
     * is no such thing as a rule to "no category".
     */
    categoryId: z.number().int().nullable(),
    scope: z.enum(['one_off', 'update_rule']),
    note: z.string().nullable(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: 'no fields to update' })
  .refine((p) => !('categoryId' in p) || 'scope' in p, {
    message: 'scope is required when categoryId is set',
    path: ['scope'],
  })
  .refine((p) => p.categoryId !== null || p.scope !== 'update_rule', {
    message: 'cannot update a rule to no category — use one_off to uncategorize',
    path: ['scope'],
  });
export type TransactionPatch = z.infer<typeof zTransactionPatch>;

/**
 * Result of a relabel/annotate. `relabeledCount` is how many *other* committed
 * transactions were retroactively relabeled by an `update_rule` scope (rows
 * sharing this normalized counterparty with `category_source='rule'`); 0 for
 * `one_off`, note-only edits, or when nothing else matched.
 */
export const zTransactionPatchResult = z.object({
  transaction: zTransaction,
  relabeledCount: z.number().int(),
});
export type TransactionPatchResult = z.infer<typeof zTransactionPatchResult>;
