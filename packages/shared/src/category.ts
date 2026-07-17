import { z } from 'zod';
import { zEpochMs, zHexColor } from './common';

/** System built-ins; everything else is an ordinary user category (spec 001). */
export const CATEGORY_SYSTEM_KEYS = ['transfer', 'income'] as const;
export const zCategorySystemKey = z.enum(CATEGORY_SYSTEM_KEYS);
export type CategorySystemKey = z.infer<typeof zCategorySystemKey>;

// `system_key` is never client-settable: system categories exist only via the
// seed migration. POST always creates an ordinary (or income-source) category.
export const zCategoryCreate = z.object({
  name: z.string().trim().min(1),
  isIncomeSource: z.boolean().optional(),
  color: zHexColor.nullish(),
  sortOrder: z.number().int().optional(),
});
export type CategoryCreate = z.infer<typeof zCategoryCreate>;

// `archived` toggles the soft-delete: true sets `archived_at`, false clears it.
// System-category locks (no archive, no is_income_source change) are enforced in
// the handler, not here, since they depend on the target row.
export const zCategoryPatch = z
  .object({
    name: z.string().trim().min(1),
    isIncomeSource: z.boolean(),
    color: zHexColor.nullable(),
    sortOrder: z.number().int(),
    archived: z.boolean(),
  })
  .partial()
  .refine((c) => Object.keys(c).length > 0, { message: 'no fields to update' });
export type CategoryPatch = z.infer<typeof zCategoryPatch>;

/** API response shape (timestamps are epoch-ms). */
export const zCategory = z.object({
  id: z.number().int(),
  name: z.string(),
  systemKey: zCategorySystemKey.nullable(),
  isIncomeSource: z.boolean(),
  color: z.string().nullable(),
  sortOrder: z.number().int(),
  archivedAt: zEpochMs.nullable(),
  createdAt: zEpochMs,
});
export type Category = z.infer<typeof zCategory>;
