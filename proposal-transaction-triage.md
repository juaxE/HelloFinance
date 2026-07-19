# Proposal: transaction triage

Status: awaiting owner review. Delete on merge — the residue is the criterion-named
tests plus the tripwire lines at the bottom.

## Why

`commitImport(…, { allowUncategorized: true })` lets rows land with
`category_id IS NULL`, and nothing in the UI ever addresses them again. The
grouping UI that would resolve them (`GroupCard`) is bound to `import_rows` and
disappears at commit. So the backlog is a first-class state with no owner.

## Behavior

A **Triage** view lists every committed transaction with `category_id IS NULL`,
bunched by `normalizeCounterparty(counterparty)`.

- **Repeat groups** (count > 1) — `ALEPA`, `PRISMA`, … — sorted by count
  descending. One category picker per group. Two actions: apply to all N, and
  apply to all N *and remember as a rule*.
- **Singletons** (count == 1) in a separate section below. `MOB.PAY*` is stripped
  by the normalizer, so MobilePay payments key on the recipient's name and land
  here naturally. No rule affordance — a rule on a one-time payee is noise.
- Keyboard-first: the picker takes focus, Enter applies, focus advances to the
  next group. No pagination — seeing the whole backlog is the point.
- Entry point is the dashboard's needs-review card. The nav item is present only
  while the count is non-zero.

### `category_source`

**`rule` iff a labeling rule for this normalized counterparty exists and maps to
the chosen category; otherwise `manual`.**

That single sentence covers all three paths, and it is the load-bearing decision
here. Bulk-applying 43 rows as `manual` would be the tempting alternative and is
a trap: `manual` is never rewritten by a later rule correction, so one wrong
click would freeze a mistake across a year of history. Rows derived from a rule
must keep following that rule.

### Existing rules are never rewritten from here

Triage INSERTs rules; it never UPDATEs one.

- Rule exists and the picked category matches it → bulk apply, source `rule`.
- Rule exists and the picked category differs → the bulk actions are disabled,
  with a pointer to the Rules screen. Per-transaction categorization stays
  available (`scope: 'one_off'`, source `manual`).
- No rule exists → both bulk actions available.

The 409 below enforces this server-side, so no UI path can bypass it.

### Undo

Applying a group is not gated by a confirmation — a confirm on every group would
destroy the fluidity this view exists for. Instead the last group-apply is
undoable for the session: rows return to `(null, null)`, and a rule created by
that same action is deleted. Without it the fast path is one misclick away from
43 silently mislabeled rows and no filter to find them again.

## Data model

**No migration.** No new columns, no changes to `labeling_rules` or
`transactions`.

Grouping normalizes in JS over the uncategorized rows, matching what
`transactions.ts:74-78` already does for rule-sourced rows. A stored
`normalized_counterparty` column was considered and rejected: `BRAND_KEYS` is
explicitly intended to become user-editable, which would make the column a
denormalization requiring a full recompute on every normalizer change. At this
corpus size the JS pass is not measurable.

## API surface

- `GET /api/transactions/uncategorized` → `{ totalCount, groups: [{
  normalizedCounterparty, exampleRaw, count, totalAmountCents, existingRule:
  { categoryId } | null, rows: [...] }] }`, groups sorted by count desc then
  total amount desc.
- `GET /api/transactions/uncategorized/count` → `{ count }`, for the nav badge.
- `POST /api/transactions/triage/group` — body `{ normalizedCounterparty,
  categoryId, rememberRule }`. Applies to every uncategorized row matching the
  key. `409` when `rememberRule` is true and a rule for that key already exists,
  or when `categoryId` conflicts with an existing rule. Returns
  `{ appliedCount, undoToken }`.
- `POST /api/transactions/triage/undo` — body `{ undoToken }`.
- Per-transaction categorization reuses `PATCH /api/transactions/:id` with
  `scope: 'one_off'`. Unchanged.

A new endpoint rather than a flag on the existing relabel route: that route's
retroactive sweep filters `eq(transactions.categorySource, 'rule')`, and the
check constraint at `schema.ts:178-180` makes `category_source` null for exactly
the rows triage targets. It is structurally unable to match them.

## Shared grouping — dropped after reading the code

The proposal originally called for extracting one grouping function used by both
`pipeline.ts` and triage. Reading `getImportDetail` shows that is wrong:
`pipeline.ts:306` groups on `staged_transactions.normalized_counterparty`, a
**stored column** that `transactions` does not have, and everything around the
bucketing (proposals, `remember_rule`, `before_opening`) is staging-specific
with no triage analogue. What would actually be shared is ~8 lines of Map
bucketing — a speculative abstraction, not drift protection.

The real shared surface is `normalizeCounterparty`, a pure function both paths
already call. That is what keeps them agreeing on what counts as the same
counterparty, and it needed no change.

## Known gap surfaced by the fixtures

`stripTrailingProcessorToken` only strips a trailing `*`-segment when it
contains a digit, so `PAYPAL *SPOTIFY*P1DXYSB` normalizes to `SPOTIFY` while
`PAYPAL *SPOTIFY*PAYSCU` and `PAYPAL *SPOTIFY*PPBOGT` do not — the seeded
backlog shows Spotify as one group of 10 plus two singletons. Not fixed here:
loosening that rule risks eating real counterparty words, and the fix belongs
with the deferred "edit the normalizer when grouping is wrong" work.

## Acceptance criteria

1. A committed transaction with `category_id IS NULL` appears in exactly one
   triage group, keyed on its normalized counterparty.
2. Rows whose counterparties differ only by store number or brand suffix
   (`ALEPA KAMPPI`, `ALEPA 0123`) share one group.
3. Applying a group with `rememberRule: true` sets every matching uncategorized
   row to the category with source `rule`, and inserts one labeling rule.
4. Applying a group with `rememberRule: false` and no existing rule sets source
   `manual` and inserts no rule.
5. Applying a group whose key already has a rule mapping to the same category
   sets source `rule` and inserts nothing.
6. `POST …/triage/group` returns 409 when the key has a rule mapping to a
   different category, and writes nothing.
7. Categorizing a single row via `scope: 'one_off'` sets source `manual`, leaves
   its group's other rows uncategorized, and creates no rule.
8. Undo restores the applied rows to `(null, null)` and deletes a rule the same
   action created; it does not delete a rule that already existed.
9. The nav entry and dashboard card are absent when the count is zero.
10. Draining a group moves its amount out of the budgets "Needs review" bucket
    into the target category, and the month's M total is unchanged.

## Deferred

- Bulk actions across multiple groups at once.
- Editing `BRAND_KEYS` from the UI when grouping is wrong.
- Any change to the pre-commit review screen. Both views ship and coexist; the
  call on whether triage replaces `ReviewScreen` is made after living with it.
- Undo beyond the last action, or persisted across reloads.

## Tripwire candidates (add to CLAUDE.md on merge)

- Triage bulk-apply writes `category_source = 'rule'`, not `'manual'` — the rows
  are rule-derived and must follow a later correction to that rule. `manual`
  would freeze them permanently.
- Triage never UPDATEs a `labeling_rule`; a conflicting key is a 409, not an
  upsert. Rule edits belong to the Rules screen, where the retroactive blast
  radius is visible.
- The relabel sweep in `transactions.ts` filters on `category_source = 'rule'`
  and therefore cannot see uncategorized rows — the check constraint makes their
  source null. Do not "fix" triage by routing it through that endpoint.
