# Spec 003 — Budgets (recurring templates, months, reconciliation)

Status: draft, awaiting owner approval
Depends on: 001 (schema), 002 (committed transactions to reconcile against).
Depended on by: 004 (dashboard reads this spec's budget reconciliation).

## Purpose

Let the owner plan monthly spending from **recurring templates**, materialize a
month's budget from the active templates, edit/extend it with ad-hoc lines, and
reconcile planned vs. actual against imported transactions. Editing a template
affects only **future** months; already-materialized months are a historical
record. Reconciliation matches **named recurring lines by counterparty** and
reconciles **everything else at category level**.

## Model recap (tables from 001)

- `recurring_templates` — the plan source (name, category, per-occurrence amount,
  `interval_months` cadence, expected day, `start_month`/`end_month`, optional
  `match_normalized_counterparty`, optional `note`).
- `budgets` — one row per materialized `YYYY-MM`, with an optional month-level `note`.
- `budget_lines` — per-month **snapshot** of a template, or an ad-hoc one-off.
  Carries its own `name`, `categoryId`, `amountCents`, `expectedDayOfMonth`,
  `matchNormalizedCounterparty`, `note`, `kind`.

Actuals are **never stored** — always computed from `transactions` by
`payment_date` month. This keeps budgets consistent after re-imports/relabels.

## Behavior

### Materialization

- A month is materialized on demand (opening the month, or `POST /api/budgets`).
- For each template **due** in the target month **M**, insert one `budget_line`
  (`kind='recurring'`) snapshotting the template's current values, including
  `amount_cents`, `match_normalized_counterparty` and `note`, and clamping
  `expected_day_of_month` to the month length (day 31 → 30 in June, 28/29 in
  February; see 003-A). A template is **due** in M iff:
  - `M ≥ start_month` and (`end_month` is null or `M ≤ end_month`), **and**
  - `monthsBetween(start_month, M) mod interval_months == 0`, where
    `monthsBetween(a, b) = (b.year·12 + b.month) − (a.year·12 + a.month)` for
    `YYYY-MM` months.

  So a monthly template (`interval_months=1`) is due every active month; a
  quarterly one (`3`) every third month from its anchor; a yearly one (`12`) only
  in its anniversary month. Non-due months simply get no line for that template —
  the full charge lands, once, in the month it is actually billed (decision 001-H).
  `amount_cents` is the per-occurrence charge and is snapshotted **as-is, no
  division**.

- **Idempotent**: materializing an existing `budgets` row does nothing (lines are
  not regenerated, so user edits survive). Re-materialization never duplicates
  lines.
- **Deletion is durable (intentional).** Deleting a materialized recurring line
  removes it for good: re-opening or re-materializing the month is a no-op and will
  **not** regenerate it (the month row already exists). A line you deleted for a
  given month stays deleted — this is by design, not an accident of the unique
  index (review Q2).

### Editing semantics (future-only)

- Editing a `recurring_template` updates the template row only. Already-materialized
  `budget_lines` are untouched — they are snapshots. The edit is reflected the next
  time a not-yet-materialized month is created.
- Within a materialized month, individual `budget_lines` are freely editable and
  deletable (amount, name, category, expected day, match key, note). These edits
  are local to that month. The month itself also has an editable `note`.
- Ad-hoc lines: `POST` a `budget_line` with `kind='adhoc'`, `template_id=null`.
- **Creating/retargeting a template for an already-materialized month.** A month
  materializes exactly once (`uq_budgets_month`), so a template created — or made
  newly due — _after_ its month was materialized would otherwise not appear until
  the next fresh month. On create/edit, if the template is due in an
  already-materialized month that is the **current or a future** month, the API
  offers to insert its snapshot line into that month (a targeted insert, not a
  re-materialization). Already-closed past months are left as the historical
  record. Silently skipping the current month would read as a bug (review Q1).

### Reconciliation (planned vs. actual, per month)

Let **M** = the set of that month's transactions (by `payment_date`), excluding
`Transfer`-category transactions entirely.

1. **Named recurring lines** (`kind='recurring'` with a non-null
   `match_normalized_counterparty`): actual = sum of `M` rows whose
   `normalized_counterparty` equals the line's key. Matching is **strictly within
   the month** — a line only ever matches transactions in its own month; there is
   no fuzzy or adjacent-month matching. Matched transactions are **consumed**
   (removed from M) so they are not counted again below. If **no** M row matches
   (the expected charge is absent, or it posted in a different month), the line's
   actual is **0** and it is shown **pending / unmatched** — planned but not yet
   seen — never silently dropped or back-filled from a neighbouring month.
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

**Calendar drift is visible on both sides (by design).** Because matching is strict
within-month, a bill that posts a month later than its line is due appears twice in
the reconciliation view — the due month's line reads _pending_ (no match), and the
actual month surfaces the charge under **unbudgeted** (no line covers it there).
This is deliberate: letting a line reach into adjacent months would hide the slip
and risk double-counting across two months' budgets. The owner sees the drift and
can adjust, rather than the number quietly absorbing it.

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
  `PATCH/DELETE /api/recurring-templates/:id` — fields: `name`, `categoryId`,
  `amountCents` (per occurrence), `intervalMonths`, `expectedDayOfMonth`,
  `startMonth`, `endMonth?`, `matchNormalizedCounterparty?`, `note?`. When a
  create/edit makes the template due in the current (already-materialized) month,
  the response carries an `addableToMonths: ['YYYY-MM']` hint the UI acts on to
  insert the line now (review Q1).

## UI sketch

- **Templates** (Settings or a Budgets sub-tab): a table of recurring templates
  (name, category, per-occurrence amount, **cadence** — monthly / quarterly /
  yearly / every-N-months — expected day, start/end month, optional note).
  Add/edit/end a template. Editing shows a reminder: "applies to future months
  only"; when an edit makes the template due in the current month, it offers to add
  the line now (review Q1).
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

1. Materializing a month creates exactly one line per template **due** that month
   (monthly every month; a quarterly template only every third month from its
   anchor; a yearly template only in its anniversary month) with snapshotted
   values; materializing again is a no-op (no duplicate lines, edits preserved).
2. A template with `end_month` before month M produces no line in M; one with
   `start_month` after M produces no line in M.
3. A yearly template (`interval_months=12`, `amount_cents=60000`) matched to the
   seeded `LÄHITAPIOLA` insurance materializes a single 60000-cent line in its due
   month (2025-10) and **no** line in the other eleven months; that line reconciles
   against the month's real −600 € transaction (no monthly division anywhere). A
   quarterly template (`interval_months=3`, `amount_cents=8700`) matched to
   `PELICAN SELF STORAGE` materializes a line only in 2025-07 / 2025-10 / 2026-01 /
   2026-04, each reconciling against that month's −87 € charge. Both assert against
   `expected.json → recurringNonMonthly`.
4. Editing a template's amount does **not** change any already-materialized month;
   a newly materialized later due month reflects the new amount.
5. Creating a template due in the current, already-materialized month surfaces it
   as addable to that month (review Q1); deleting a materialized recurring line is
   durable across re-open/re-materialize (review Q2).
6. A named recurring line (e.g. the rent-like `E-LASKU`) reconciles by counterparty:
   its actual equals the sum of that counterparty's transactions in the month, and
   those transactions are not double-counted in a category-level line.
7. A category-level line reconciles to the remaining category transactions; a
   category with spend but no line appears under "unbudgeted".
8. `expected_day_of_month = 31` clamps correctly in 30-day and February months.
9. A template's `note` is snapshotted onto its materialized line; editing the
   line's note afterward does not change the template, and editing the template's
   note does not change already-materialized lines (same snapshot rule as amounts).
10. Month planned/actual totals reconcile with spec 004's cash-flow expense total
    for the same seed and month.
11. **Absent due-month.** A monthly template matched to the seeded `ELIXIA HELSINKI`
    gym shows 2026-02 as **pending / unmatched** (planned, actual 0) while the other
    eleven months reconcile; asserts against
    `expected.json → recurringNegativeCases.absentDueMonth`.
12. **Calendar drift.** A yearly template matched to `AUTOLIITTO`, anchored to its
    nominal due month (2026-02), leaves that month **pending** (no Feb charge), and
    the real charge in 2026-03 surfaces as **unbudgeted** there — strict matching
    does not reach across months; asserts against
    `recurringNegativeCases.driftedYearly`.
13. Playwright screenshot of the month view with reconciled numbers visible.

> **Test data (done).** The synthetic fixtures seed the charges these criteria
> reconcile against. **Happy path** (`expected.json → recurringNonMonthly`): a
> **yearly** home-insurance E-LASKU (`LÄHITAPIOLA`, −600 € once in 2025-10) and a
> **quarterly** self-storage KORTTIOSTO (`PELICAN SELF STORAGE`, −87 € in
> Jul/Oct/Jan/Apr). **Negative cases** (`recurringNegativeCases`) that validate
> strict matching: an **absent due-month** (the monthly `ELIXIA HELSINKI` gym is
> present 11 months but skips 2026-02) and a **drifted yearly** bill (`AUTOLIITTO`,
> nominally due 2026-02 but posted 2026-03). All are named lines (normalize to
> themselves).

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
- **003-E — Non-monthly bills: due-month only (+ dashboard stat), 2026-07-16.** ✅
  Option (a). Each non-monthly charge materializes a budget line **only in its real
  due month** (decision 001-H) and reconciles against the actual transaction —
  budgets never invent a monthly amount, so the month tie-out (criterion 10) always
  holds. The smoothing need is met **separately and read-only** on the dashboard: a
  "normalized monthly commitments" stat = Σ `amount_cents / interval_months` over
  active templates (spec 004). Sinking-fund envelopes (option b) are deferred to
  their own spec.

No open questions remain for this spec.
