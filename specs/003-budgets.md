# Spec 003 — Budgets (recurring templates, months, reconciliation)

Status: **draft, awaiting owner approval**
Depends on: 001 (schema), 002 (committed transactions to reconcile against).

## Purpose

Let the owner plan monthly spending from **recurring templates**, materialize a
month's budget from the active templates, edit/extend it with ad-hoc lines, and
reconcile planned vs. actual against imported transactions. Editing a template
affects only **future** months; already-materialized months are a historical
record. Reconciliation matches **named recurring lines by counterparty** and
reconciles **everything else at category level**.

## Model recap (tables from 001)

- `recurring_templates` — the plan source (name, category, amount, expected day,
  start/end, optional `match_normalized_counterparty`, optional `note`).
- `budgets` — one row per materialized `YYYY-MM`, with an optional month-level `note`.
- `budget_lines` — per-month **snapshot** of a template, or an ad-hoc one-off.
  Carries its own `name`, `categoryId`, `amountCents`, `expectedDayOfMonth`,
  `matchNormalizedCounterparty`, `note`, `kind`.

Actuals are **never stored** — always computed from `transactions` by
`payment_date` month. This keeps budgets consistent after re-imports/relabels.

## Behavior

### Materialization

- A month is materialized on demand (opening the month, or `POST /api/budgets`).
- For each template **active** in that month — `start_date`'s month ≤ target month,
  and (`end_date` null or its month ≥ target month) — insert one `budget_line`
  (`kind='recurring'`) snapshotting the template's current values, including
  `match_normalized_counterparty` and `note`, and clamping `expected_day_of_month`
  to the month length (e.g. day 31 → 30 in June, 28/29 in February; see 003-A).
- **Idempotent**: materializing an existing `budgets` row does nothing (lines are
  not regenerated, so user edits survive). Re-materialization never duplicates
  lines.

### Editing semantics (future-only)

- Editing a `recurring_template` updates the template row only. Already-materialized
  `budget_lines` are untouched — they are snapshots. The edit is reflected the next
  time a not-yet-materialized month is created.
- Within a materialized month, individual `budget_lines` are freely editable and
  deletable (amount, name, category, expected day, match key, note). These edits
  are local to that month. The month itself also has an editable `note`.
- Ad-hoc lines: `POST` a `budget_line` with `kind='adhoc'`, `template_id=null`.

### Reconciliation (planned vs. actual, per month)

Let **M** = the set of that month's transactions (by `payment_date`), excluding
`Transfer`-category transactions entirely.

1. **Named recurring lines** (`kind='recurring'` with a non-null
   `match_normalized_counterparty`): actual = sum of `M` rows whose
   `normalized_counterparty` equals the line's key. These matched transactions are
   **consumed** (removed from M) so they are not counted again below.
2. **Category-level lines** (everything else — ad-hoc lines, and recurring lines
   without a match key): actual = sum of the **remaining** M rows in that line's
   category. **At most one category-level line per category is allowed** (decision
   003-B): a category-level line reconciles against a whole category, so two of
   them competing for the same category would be ambiguous. The API rejects a
   second category-level line in a category the month already has one for
   (`409`), and points the user at either editing the existing line or making the
   new one a **named** line (with a `match_normalized_counterparty`, which can
   freely coexist because it consumes only its own matched transactions in step 1).
3. **Unbudgeted spending**: remaining M rows in categories that have no line are
   surfaced as "unbudgeted" per category (so the month view reconciles to the full
   cash-flow total, not just budgeted categories).

Variance per line = `plannedMagnitude − actualMagnitude` (both positive). Actual
is the absolute value of summed (negative) expense transactions; incoming refunds
in a category net down that category's actual.

The month total (planned vs. actual vs. unbudgeted) must reconcile exactly with
the cash-flow expense total for the same month computed in spec 004 — a mismatch
is a critical finding, not a footnote (CLAUDE.md validation §6).

## API surface

- `GET /api/budgets/:month` → the budget with lines, each line's computed actual +
  variance, plus an `unbudgeted` section. Auto-materializes the **current** month
  and any month the user explicitly opens; other absent months return an
  uncreated marker rather than being materialized on a glance (decision 003-C).
- `POST /api/budgets` `{ month }` → materialize explicitly.
- `PATCH /api/budgets/:month` `{ note? }` → edit the month-level note.
- `POST /api/budgets/:month/lines` `{ kind:'adhoc', name, categoryId, amountCents,
expectedDayOfMonth?, note? }` → add ad-hoc line.
- `PATCH /api/budgets/:month/lines/:id` `{ …, note? }` → edit a line (incl. note).
- `DELETE /api/budgets/:month/lines/:id` → delete a line.
- Templates CRUD: `GET/POST /api/recurring-templates`,
  `PATCH/DELETE /api/recurring-templates/:id` (all accept an optional `note`).

## UI sketch

- **Templates** (Settings or a Budgets sub-tab): a table of recurring templates
  (name, category, amount, expected day, start/end, optional note). Add/edit/end a
  template. Editing shows a reminder: "applies to future months only".
- **Month view**: a month picker; a list of lines grouped as Recurring then
  Ad-hoc, each row showing planned, actual, variance, a small day-of-month marker,
  and an optional per-line note; color/no-judgment bar showing actual vs planned.
  An "Unbudgeted" group lists categories with spending but no line. A month-level
  note field sits at the top. Buttons: "Add ad-hoc line", "Materialize month" (if
  not yet created). A month footer totals planned vs. actual and shows the
  reconciliation tie-out to cash flow.

## Acceptance criteria

Against seeded fixtures (known recurring patterns — salary, rent-like e-lasku,
subscriptions):

1. Materializing a month creates exactly one line per active template with
   snapshotted values; materializing again is a no-op (no duplicate lines, edits
   preserved).
2. A template with `end_date` before month M produces no line in M; one starting
   after M produces no line in M.
3. Editing a template's amount does **not** change any already-materialized month;
   a newly materialized later month reflects the new amount.
4. A named recurring line (e.g. the rent-like `E-LASKU`) reconciles by counterparty:
   its actual equals the sum of that counterparty's transactions in the month, and
   those transactions are not double-counted in a category-level line.
5. A category-level line reconciles to the remaining category transactions; a
   category with spend but no line appears under "unbudgeted".
6. `expected_day_of_month = 31` clamps correctly in 30-day and February months.
7. A template's `note` is snapshotted onto its materialized line; editing the
   line's note afterward does not change the template, and editing the template's
   note does not change already-materialized lines (same snapshot rule as amounts).
8. Month planned/actual totals reconcile with spec 004's cash-flow expense total
   for the same seed and month.
9. Playwright screenshot of the month view with reconciled numbers visible.

## Deferred (needs a new approved spec)

- **Income budgeting** (templates are expenses only — CLAUDE.md deferred list).
- Budget rollover / carry-over of under/overspend between months.
- Multi-month or annual budget views.
- Auto-suggesting templates from detected recurring transactions.

## Resolved decisions (owner, 2026-07-15)

- **003-A — Short-month clamping.** ✅ Clamp. _Context:_ a template can say "due on
  day 31", but June has 30 days and February 28. Clamping shows such a line on the
  last day of shorter months (31 → 30 / 28 / 29). It only affects the line's
  displayed due-day and ordering — reconciliation is whole-month, so the actual is
  unaffected either way. The alternative (dropping the line in months lacking that
  day) would make a recurring expense vanish some months — undesirable.
- **003-B — Multiple lines, one category.** ✅ Disallow two **category-level** lines
  in the same category. _Context:_ a category-level line reconciles against the
  whole category's transactions; if two such lines pointed at, say, "Subscriptions",
  there'd be no unambiguous way to split the category's actual between them, and the
  month total could stop tying out. So the API rejects the second one (`409`).
  You can still have a **named** line (matched by counterparty, e.g. "Spotify")
  alongside a category-level "Subscriptions" line: the named line consumes only its
  own matched transactions first, and the category-level line reconciles against the
  remainder — no ambiguity.
- **003-C — Auto-materialize on GET.** ✅ Auto-materialize the current month and any
  month the user explicitly opens; other absent months return an uncreated marker.
- **003-D — Named-line match source.** ✅ Set the match key manually, assisted.
  _Context:_ a named line (e.g. "Rent") needs to know which transactions _are_ the
  rent; it matches by `normalized_counterparty` (e.g. `ASUNTO OY HELSINGIN
ESIMERKKI`). Rather than guessing from the free-text template name (fragile), the
  template editor lets you **pick** the counterparty — from an existing labeling
  rule or a recent transaction — and stores that normalized key. Explicit and
  reliable.

No open questions remain for this spec.
