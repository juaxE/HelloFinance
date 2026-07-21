import { z } from 'zod';
import { zIsoDate } from './common';

/** Spec 002 import lifecycle. */
export const IMPORT_STATUSES = ['pending_review', 'committed', 'discarded'] as const;
export const zImportStatus = z.enum(IMPORT_STATUSES);
export type ImportStatus = z.infer<typeof zImportStatus>;

export const zDetectedEncoding = z.enum(['utf-8', 'iso-8859-1']);
export type DetectedEncoding = z.infer<typeof zDetectedEncoding>;

export const DUP_STATES = ['duplicate_existing', 'duplicate_in_batch'] as const;
export const zDupState = z.enum(DUP_STATES);
export type DupState = z.infer<typeof zDupState>;

/** A single staged row, as shown inside an expanded review group. */
export const zStagedRow = z.object({
  id: z.number().int(),
  paymentDate: zIsoDate,
  amountCents: z.number().int(),
  counterparty: z.string(),
  note: z.string().nullable(),
  proposedCategoryId: z.number().int().nullable(),
  chosenCategoryId: z.number().int().nullable(),
  beforeOpening: z.boolean(),
});
export type StagedRow = z.infer<typeof zStagedRow>;

/** One review-screen card: all staged 'new' rows sharing a normalized counterparty. */
export const zStagedGroup = z.object({
  normalizedCounterparty: z.string(),
  exampleRaw: z.string(),
  count: z.number().int(),
  totalAmountCents: z.number().int(),
  // Pre-filled from an existing labeling rule ("from rule" badge).
  fromRule: z.boolean(),
  proposedCategoryId: z.number().int().nullable(),
  // Uniform chosen category across the group's rows, if any (bulk "apply to all").
  chosenCategoryId: z.number().int().nullable(),
  rememberRule: z.boolean(),
  rows: z.array(zStagedRow),
});
export type StagedGroup = z.infer<typeof zStagedGroup>;

export const zDuplicateRow = z.object({
  id: z.number().int(),
  paymentDate: zIsoDate,
  amountCents: z.number().int(),
  counterparty: z.string(),
  dupState: zDupState,
  duplicateAccountId: z.number().int().nullable(),
});
export type DuplicateRow = z.infer<typeof zDuplicateRow>;

export const zImportCounts = z.object({
  total: z.number().int(),
  new: z.number().int(),
  duplicates: z.number().int(),
});
export type ImportCounts = z.infer<typeof zImportCounts>;

/**
 * Before-opening summary (decision 001-A / 002-E). `extendOffered` reflects the
 * server-side guard: the "Extend history" assist is exact only when the file
 * bridges the gap, so the UI offers it iff this is true.
 */
export const zBeforeOpeningSummary = z.object({
  count: z.number().int(),
  earliestDate: zIsoDate.nullable(),
  sumNewCents: z.number().int(),
  extendOffered: z.boolean(),
});
export type BeforeOpeningSummary = z.infer<typeof zBeforeOpeningSummary>;

/**
 * One row of `GET /api/imports` — the list/resume view. Deliberately flat: no
 * staged rows, so listing stays cheap regardless of how big an import was.
 */
export const zImportSummary = z.object({
  id: z.number().int(),
  filename: z.string(),
  accountId: z.number().int(),
  bank: z.literal('s-pankki'),
  status: zImportStatus,
  encoding: zDetectedEncoding,
  rowCount: z.number().int(),
  insertedCount: z.number().int(),
  duplicateCount: z.number().int(),
  createdAt: z.number().int(),
});
export type ImportSummary = z.infer<typeof zImportSummary>;

/** Response for both `POST /api/imports` and `GET /api/imports/:id`. */
export const zImportDetail = z.object({
  importId: z.number().int(),
  status: zImportStatus,
  accountId: z.number().int(),
  filename: z.string(),
  encoding: zDetectedEncoding,
  counts: zImportCounts,
  groups: z.array(zStagedGroup),
  duplicates: z.array(zDuplicateRow),
  beforeOpening: zBeforeOpeningSummary,
});
export type ImportDetail = z.infer<typeof zImportDetail>;

/** `PATCH /api/imports/:id/groups/:normalizedCounterparty` — bulk apply to a group. */
export const zGroupPatch = z.object({
  categoryId: z.number().int().nullable(),
  rememberRule: z.boolean(),
});
export type GroupPatch = z.infer<typeof zGroupPatch>;

/** `PATCH /api/imports/:id/rows/:rowId` — single-row override and/or note. */
export const zRowPatch = z
  .object({
    categoryId: z.number().int().nullable(),
    note: z.string().nullable(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: 'no fields to update' });
export type RowPatch = z.infer<typeof zRowPatch>;

/** `POST /api/imports/:id/commit`. */
export const zCommitRequest = z.object({
  allowUncategorized: z.boolean().optional(),
});
export type CommitRequest = z.infer<typeof zCommitRequest>;

export const zCommitResult = z.object({
  inserted: z.number().int(),
  duplicates: z.number().int(),
  uncategorized: z.number().int(),
});
export type CommitResult = z.infer<typeof zCommitResult>;

/** `POST /api/imports/:id/extend-history` (decision 002-E). */
export const zExtendHistoryResult = z.object({
  openingBalanceDate: zIsoDate,
  openingBalanceCents: z.number().int(),
  extendedRowCount: z.number().int(),
});
export type ExtendHistoryResult = z.infer<typeof zExtendHistoryResult>;
