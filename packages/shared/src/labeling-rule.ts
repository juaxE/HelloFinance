import { z } from 'zod';
import { zEpochMs } from './common';

/**
 * A learned normalized-counterparty -> category mapping (spec 002). Manual
 * label always beats a rule; a rule only auto-fills rows the user has not
 * manually decided.
 */
export const zLabelingRule = z.object({
  id: z.number().int(),
  normalizedCounterparty: z.string(),
  categoryId: z.number().int(),
  exampleRaw: z.string().nullable(),
  createdAt: zEpochMs,
  updatedAt: zEpochMs,
});
export type LabelingRule = z.infer<typeof zLabelingRule>;

export const zLabelingRulePatch = z.object({
  categoryId: z.number().int(),
});
export type LabelingRulePatch = z.infer<typeof zLabelingRulePatch>;
