import { z } from 'zod';
import { zEpochMs, zMonth } from './common';

/**
 * Assets and their manual monthly snapshots (spec 004).
 *
 * Assets are the holdings that are NOT bank accounts: investments, loans, and
 * any other non-bank value. The emergency fund is deliberately absent — it is a
 * bank Account of kind `buffer`, so its balance already reaches net worth
 * through the account term (decision 001-D).
 */

/** Loans contribute negatively to net worth; investment/other positively. */
export const ASSET_KINDS = ['investment', 'loan', 'other'] as const;
export const zAssetKind = z.enum(ASSET_KINDS);
export type AssetKind = z.infer<typeof zAssetKind>;

export const zAssetCreate = z.object({
  name: z.string().trim().min(1),
  kind: zAssetKind,
});
export type AssetCreate = z.infer<typeof zAssetCreate>;

/**
 * Rename, or archive/unarchive by setting `archived` (decision 004-F).
 *
 * Archiving is a FORM-VISIBILITY change only: it removes the asset from the
 * snapshot-entry form and nothing else. Its existing snapshots keep carrying
 * forward into every month `>=` their own, so net worth in a past month can
 * never change because of an action taken today. Ending an asset's contribution
 * is a data step — enter a final `0` snapshot, then archive.
 */
export const zAssetPatch = z
  .object({
    name: z.string().trim().min(1),
    archived: z.boolean(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: 'no fields to update' });
export type AssetPatch = z.infer<typeof zAssetPatch>;

export const zAsset = z.object({
  id: z.number().int(),
  name: z.string(),
  kind: zAssetKind,
  archivedAt: zEpochMs.nullable(),
  createdAt: zEpochMs,
});
export type Asset = z.infer<typeof zAsset>;

/**
 * A month's snapshot values, for the entry form.
 *
 * `carriedForward` marks a value that is NOT this month's own entry but the
 * latest earlier one (decision 004-B) — the form pre-fills it so saving an
 * unchanged month is a deliberate act rather than an accident.
 */
export type AssetSnapshotEntry = {
  assetId: number;
  name: string;
  kind: AssetKind;
  /** `null` when the asset has no snapshot at or before this month. */
  valueCents: number | null;
  carriedForward: boolean;
  /** The month the shown value was actually entered in; null when there is none. */
  sourceMonth: string | null;
};

/**
 * Partial upsert, same semantics as `PUT …/envelopes` in spec 003: assets
 * OMITTED from `values` are left untouched. There is no delete-by-omission — a
 * partial save can never silently wipe a snapshot the screen didn't render.
 * Clearing an asset's contribution is an explicit `valueCents: 0`, which is a
 * real snapshot and carries forward like any other.
 */
export const zAssetSnapshotsPut = z.object({
  month: zMonth,
  values: z.array(
    z.object({
      assetId: z.number().int(),
      /** Loans are entered POSITIVE and subtracted by the net-worth formula. */
      valueCents: z.number().int(),
    }),
  ),
});
export type AssetSnapshotsPut = z.infer<typeof zAssetSnapshotsPut>;
