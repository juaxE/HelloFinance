import { z } from 'zod';

/**
 * ISO calendar date `YYYY-MM-DD` — the wire format for all business dates
 * (booking/payment/opening-balance). No time, no timezone (spec 001 conventions).
 * Validates both the shape and that it is a real calendar date (rejects
 * `2026-02-30`).
 */
export const zIsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'not a valid calendar date');

/** Month granularity `YYYY-MM` (budgets, snapshots, recurring templates). */
export const zMonth = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected YYYY-MM');

/** Optional hex color `#rrggbb` for category/chart swatches (UI concern). */
export const zHexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'expected #rrggbb hex color');

/** Timestamps cross the wire as epoch-ms integers (stored as `timestamp_ms`). */
export const zEpochMs = z.number().int();
