import { z } from 'zod';
import { zEpochMs, zMonth } from './common';

/**
 * Budgets (spec 003): recurring templates (bills), materialized months, and
 * budget lines. A line's reconciliation behavior is set by its **match key**,
 * never by its `kind` (decision 003-G):
 *   - named   (`matchNormalizedCounterparty` non-null) — consumes its
 *             counterparty's transactions;
 *   - envelope (no match key) — takes its category's remainder.
 * `kind` records provenance only. The per-kind invariants below are enforced
 * identically on POST and PATCH, so a patch can never reach a state the
 * corresponding POST would have rejected.
 */

/** `envelope` is added by decision 003-I; the column is unconstrained text, so no SQL migration. */
export const BUDGET_LINE_KINDS = ['recurring', 'adhoc', 'envelope'] as const;
export const zBudgetLineKind = z.enum(BUDGET_LINE_KINDS);
export type BudgetLineKind = z.infer<typeof zBudgetLineKind>;

/** Planned amounts are magnitudes, stored positive (decision 001-C). */
const zPlannedAmountCents = z.number().int().nonnegative();
const zDayOfMonth = z.number().int().min(1).max(31);
/** A normalized counterparty key; never blank — absence is expressed as null. */
const zMatchKey = z.string().trim().min(1);

// --- Recurring templates ---------------------------------------------------

/**
 * `matchNormalizedCounterparty` is **required** (decision 003-L): a template is
 * a bill, and anything without a counterparty is a goal, which is an envelope.
 * It must also be unique across non-ended templates (decision 003-N) — enforced
 * in the handler, which needs the current month and the other rows.
 */
export const zRecurringTemplateCreate = z.object({
  name: z.string().trim().min(1),
  categoryId: z.number().int(),
  amountCents: zPlannedAmountCents,
  intervalMonths: z.number().int().min(1).default(1),
  expectedDayOfMonth: zDayOfMonth,
  startMonth: zMonth,
  endMonth: zMonth.nullish(),
  matchNormalizedCounterparty: zMatchKey,
  note: z.string().nullish(),
});
export type RecurringTemplateCreate = z.infer<typeof zRecurringTemplateCreate>;

/**
 * Every field is optional, but `matchNormalizedCounterparty` stays non-nullable:
 * clearing a template's key would recreate the keyless-template design 003-L
 * closed. Retargeting it to a different counterparty is allowed (provider
 * switch), future-only like any other template edit.
 */
export const zRecurringTemplatePatch = z
  .object({
    name: z.string().trim().min(1),
    categoryId: z.number().int(),
    amountCents: zPlannedAmountCents,
    intervalMonths: z.number().int().min(1),
    expectedDayOfMonth: zDayOfMonth,
    startMonth: zMonth,
    endMonth: zMonth.nullable(),
    matchNormalizedCounterparty: zMatchKey,
    note: z.string().nullable(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: 'no fields to update' });
export type RecurringTemplatePatch = z.infer<typeof zRecurringTemplatePatch>;

export const zRecurringTemplate = z.object({
  id: z.number().int(),
  name: z.string(),
  categoryId: z.number().int(),
  amountCents: z.number().int(),
  intervalMonths: z.number().int(),
  expectedDayOfMonth: z.number().int(),
  startMonth: z.string(),
  endMonth: z.string().nullable(),
  matchNormalizedCounterparty: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: zEpochMs,
  updatedAt: zEpochMs,
});
export type RecurringTemplate = z.infer<typeof zRecurringTemplate>;

/**
 * A create/edit response. `addableToMonths` lists already-materialized months
 * (current or future) the template is now due in — a month materializes exactly
 * once, so without this the line would not appear until the next fresh month,
 * which would read as a bug (review Q1). Acting on the hint is an **ordinary
 * line insert** and can itself 409 (decision 003-N).
 */
export const zRecurringTemplateResponse = zRecurringTemplate.extend({
  addableToMonths: z.array(zMonth),
});
export type RecurringTemplateResponse = z.infer<typeof zRecurringTemplateResponse>;

// --- Budget lines ----------------------------------------------------------

/**
 * Ad-hoc lines are always named (decision 003-J): a planned one-off with no
 * known counterparty is a raised envelope plus a note, not a line.
 */
export const zAdhocLineCreate = z.object({
  kind: z.literal('adhoc'),
  name: z.string().trim().min(1),
  categoryId: z.number().int(),
  amountCents: zPlannedAmountCents,
  matchNormalizedCounterparty: zMatchKey,
  expectedDayOfMonth: zDayOfMonth.nullish(),
  note: z.string().nullish(),
});

/**
 * Envelopes are category goals: no match key, no expected day, no template.
 * Supplying either rejected field is a 400 rather than being ignored, so a
 * caller never believes it created something it did not.
 */
export const zEnvelopeLineCreate = z.object({
  kind: z.literal('envelope'),
  name: z.string().trim().min(1).optional(),
  categoryId: z.number().int(),
  amountCents: zPlannedAmountCents,
  matchNormalizedCounterparty: z.null().optional(),
  expectedDayOfMonth: z.null().optional(),
  note: z.string().nullish(),
});

export const zBudgetLineCreate = z.discriminatedUnion('kind', [
  zAdhocLineCreate,
  zEnvelopeLineCreate,
]);
export type BudgetLineCreate = z.infer<typeof zBudgetLineCreate>;

/**
 * `kind` is not patchable — it is provenance, and changing it would move a line
 * between invariant sets. The remaining per-kind invariants (an envelope may
 * never gain a match key or expected day; a named line may never lose its key)
 * depend on the target row's kind, so they are enforced in the handler.
 */
export const zBudgetLinePatch = z
  .object({
    name: z.string().trim().min(1),
    categoryId: z.number().int(),
    amountCents: zPlannedAmountCents,
    expectedDayOfMonth: zDayOfMonth.nullable(),
    matchNormalizedCounterparty: zMatchKey.nullable(),
    note: z.string().nullable(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: 'no fields to update' });
export type BudgetLinePatch = z.infer<typeof zBudgetLinePatch>;

export const zBudgetLine = z.object({
  id: z.number().int(),
  budgetId: z.number().int(),
  templateId: z.number().int().nullable(),
  kind: zBudgetLineKind,
  name: z.string(),
  categoryId: z.number().int(),
  amountCents: z.number().int(),
  expectedDayOfMonth: z.number().int().nullable(),
  matchNormalizedCounterparty: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: zEpochMs,
  updatedAt: zEpochMs,
});
export type BudgetLine = z.infer<typeof zBudgetLine>;

// --- Envelope bulk save ----------------------------------------------------

/**
 * The budget-making screen's one save action. **Upsert with partial-save
 * semantics**: a listed `amountCents: null` deletes that category's envelope,
 * and categories **omitted** from the array are left untouched — so a screen
 * that rendered a subset can never silently wipe envelopes it did not show.
 */
export const zEnvelopesPut = z.object({
  envelopes: z.array(
    z.object({
      categoryId: z.number().int(),
      amountCents: zPlannedAmountCents.nullable(),
    }),
  ),
});
export type EnvelopesPut = z.infer<typeof zEnvelopesPut>;

export const zBudgetPatch = z
  .object({ note: z.string().nullable() })
  .refine((p) => Object.keys(p).length > 0, { message: 'no fields to update' });
export type BudgetPatch = z.infer<typeof zBudgetPatch>;

export const zBudgetCreate = z.object({ month: zMonth });
export type BudgetCreate = z.infer<typeof zBudgetCreate>;

// --- Reconciliation response ----------------------------------------------

/**
 * A line with its computed actual. Actuals are **never stored** — always
 * recomputed from transactions — so budgets stay consistent across re-imports
 * and relabels. `pending` marks a named line that matched nothing this month:
 * planned but not yet seen, never back-filled from a neighbouring month.
 */
export const zReconciledLine = zBudgetLine.extend({
  actualCents: z.number().int(),
  varianceCents: z.number().int(),
  pending: z.boolean(),
});
export type ReconciledLine = z.infer<typeof zReconciledLine>;

/** Per-category decomposition: planned/actual split into envelope vs named lines. */
export const zCategoryDecomposition = z.object({
  categoryId: z.number().int(),
  plannedCents: z.number().int(),
  actualCents: z.number().int(),
  envelopePlannedCents: z.number().int(),
  envelopeActualCents: z.number().int(),
  namedPlannedCents: z.number().int(),
  namedActualCents: z.number().int(),
});
export type CategoryDecomposition = z.infer<typeof zCategoryDecomposition>;

/** A category with spend but no line at all — a normal state, neutrally reported. */
export const zUnbudgetedCategory = z.object({
  categoryId: z.number().int(),
  actualCents: z.number().int(),
});
export type UnbudgetedCategory = z.infer<typeof zUnbudgetedCategory>;

/**
 * An uncategorized transaction. Amounts are **signed** on purpose: the bucket
 * can hold positive rows (an uncategorized payback), and rendering those as
 * spending would misreport them.
 */
export const zNeedsReviewRow = z.object({
  transactionId: z.number().int(),
  paymentDate: z.string(),
  counterparty: z.string(),
  amountCents: z.number().int(),
});
export type NeedsReviewRow = z.infer<typeof zNeedsReviewRow>;

/**
 * One entry per envelope-relevant category for the budget-making screen.
 * `suggestedAmountCents` is the immediately preceding month's envelope amount —
 * **data for rendering, never a line** (decision 003-K). Nothing may manufacture
 * envelopes behind the owner's back; the zero-envelope state is the "did I
 * budget this month?" signal.
 */
export const zEnvelopeCandidate = z.object({
  categoryId: z.number().int(),
  envelopeAmountCents: z.number().int().nullable(),
  suggestedAmountCents: z.number().int().nullable(),
});
export type EnvelopeCandidate = z.infer<typeof zEnvelopeCandidate>;

export const zBudgetMonth = z.object({
  month: zMonth,
  budgetId: z.number().int(),
  /**
   * `month < currentMonth` — the month has ended and its **plan** is frozen
   * (proposal 007). Every write route 409s on it; the UI offers no write
   * affordance. Actuals in a closed month still recompute live, so the numbers
   * below keep moving when a transaction in it is relabelled.
   *
   * Server-derived on purpose: the browser's clock is not the clock the lock is
   * enforced against (`FINANCE_NOW` pins the server's in tests).
   */
  closed: z.boolean(),
  note: z.string().nullable(),
  lines: z.array(zReconciledLine),
  categories: z.array(zCategoryDecomposition),
  unbudgeted: z.array(zUnbudgetedCategory),
  needsReview: z.array(zNeedsReviewRow),
  envelopeCandidates: z.array(zEnvelopeCandidate),
  totals: z.object({
    plannedCents: z.number().int(),
    actualCents: z.number().int(),
    unbudgetedCents: z.number().int(),
    needsReviewCents: z.number().int(),
    /** The M-definition expense total — one side of criterion 10's tie-out. */
    expenseCents: z.number().int(),
  }),
  /** Zero envelope lines ⇒ the month has not been budgeted yet (decision 003-K). */
  budgeted: z.boolean(),
});
export type BudgetMonth = z.infer<typeof zBudgetMonth>;

/** An absent month the caller only glanced at is not materialized (decision 003-C). */
export const zUncreatedBudgetMonth = z.object({
  month: zMonth,
  uncreated: z.literal(true),
  /**
   * A **closed** uncreated month is the permanent answer "never budgeted" — it
   * cannot be created any more, so the UI must not offer to.
   */
  closed: z.boolean(),
});
export type UncreatedBudgetMonth = z.infer<typeof zUncreatedBudgetMonth>;
