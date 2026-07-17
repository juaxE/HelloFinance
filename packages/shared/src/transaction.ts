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
  counterpartyBic: z.string().nullable(),
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
    categoryId: z.number().int(),
    scope: z.enum(['one_off', 'update_rule']),
    note: z.string().nullable(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: 'no fields to update' })
  .refine((p) => !('categoryId' in p) || 'scope' in p, {
    message: 'scope is required when categoryId is set',
    path: ['scope'],
  });
export type TransactionPatch = z.infer<typeof zTransactionPatch>;
