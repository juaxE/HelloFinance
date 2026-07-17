import { z } from 'zod';
import { zEpochMs, zIsoDate } from './common';

/** Display label only; net-worth math counts every account equally (spec 001). */
export const ACCOUNT_KINDS = ['main', 'buffer', 'savings', 'other'] as const;
export const zAccountKind = z.enum(ACCOUNT_KINDS);
export type AccountKind = z.infer<typeof zAccountKind>;

// IBAN is normalized (spaces stripped) server-side before storage; the schema
// only bounds it loosely — it may be null for cash-like accounts.
const zIban = z.string().trim().min(1).max(42);

/**
 * Opening-balance invariant (decision 001-A): a non-zero opening balance is
 * meaningless without an anchor date, since the derived balance only counts
 * transactions on/after `opening_balance_date`. A null date ⇒ opening 0. This
 * refinement rejects the silently-ignored `cents != 0 with null date` state.
 */
export function openingBalanceIsConsistent(cents: number, date: string | null | undefined): boolean {
  return date != null || cents === 0;
}

export const zAccountCreate = z
  .object({
    name: z.string().trim().min(1),
    kind: zAccountKind.optional(),
    iban: zIban.nullish(),
    openingBalanceCents: z.number().int().optional(),
    openingBalanceDate: zIsoDate.nullish(),
  })
  .refine((a) => openingBalanceIsConsistent(a.openingBalanceCents ?? 0, a.openingBalanceDate), {
    message: 'opening_balance_cents must be 0 when opening_balance_date is null',
    path: ['openingBalanceCents'],
  });
export type AccountCreate = z.infer<typeof zAccountCreate>;

// All fields optional; the opening-balance invariant is enforced in the handler
// against the merged (existing + patch) state, since either field may be absent.
export const zAccountPatch = z
  .object({
    name: z.string().trim().min(1),
    kind: zAccountKind,
    iban: zIban.nullable(),
    openingBalanceCents: z.number().int(),
    openingBalanceDate: zIsoDate.nullable(),
  })
  .partial()
  .refine((a) => Object.keys(a).length > 0, { message: 'no fields to update' });
export type AccountPatch = z.infer<typeof zAccountPatch>;

/** API response shape (timestamps are epoch-ms). */
export const zAccount = z.object({
  id: z.number().int(),
  name: z.string(),
  kind: zAccountKind,
  iban: z.string().nullable(),
  openingBalanceCents: z.number().int(),
  openingBalanceDate: z.string().nullable(),
  createdAt: zEpochMs,
});
export type Account = z.infer<typeof zAccount>;
