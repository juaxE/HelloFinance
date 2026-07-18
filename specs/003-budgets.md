# Spec 003 — Budgets (bills, envelopes, months, reconciliation)

Status: draft, awaiting owner approval
Depends on: 001 (schema), 002 (committed transactions to reconcile against).
Depended on by: 004 (dashboard reads this spec's budget reconciliation).

## Purpose

Let the owner plan a month's spending with **two distinct instruments**, and
reconcile planned vs. actual against imported transactions:

- **Bills** — a `recurring_template` is a known charge: fixed amount, cadence, due
  day, and (usually) a counterparty. It **materializes** into the month
  automatically. Editing a template affects only **future** months;
  already-materialized months are a historical record.
- **Envelopes** — a rough, per-month **goal for a category** ("Groceries: 400 this
  month"), set by hand when making the month's budget and expected to change month
  to month. An envelope is **not** a template, is never materialized from anything,
  and carries no cadence, due day, or counterparty (decision 003-I).

Reconciliation has exactly **two behaviors**, and which one a line gets is
determined by its **match key**, never by its `kind` (decision 003-G):

- **Named lines** (`match_normalized_counterparty` non-null — recurring or ad-hoc)
  **consume** their counterparty's transactions.
- **Envelopes** (no match key) take their category's **remainder**.

## Model recap (tables from 001)

- `recurring_templates` — the bill plan source (name, category, per-occurrence
  amount, `interval_months` cadence, expected day, `start_month`/`end_month`,
  optional `match_normalized_counterparty`, optional `note`).
- `budgets` — one row per materialized `YYYY-MM`, with an optional month-level `note`.
- `budget_lines` — per-month **snapshot** of a template, an ad-hoc one-off, or an
  **envelope**. Carries its own `name`, `categoryId`, `amountCents`,
  `expectedDayOfMonth`, `matchNormalizedCounterparty`, `note`, `kind`.

### `kind` and its invariants

`kind` is **provenance**, not reconciliation behavior. This spec adds a third
value, `'envelope'`, to the existing `'recurring' | 'adhoc'` enum. The `kind`
column is plain `text NOT NULL` in migration `0000` with **no** CHECK constraint,
so this is a **TypeScript-level enum change only — no SQL migration** (verified
against `drizzle/0000_dusty_masque.sql:33`).

| `kind`      | `match_normalized_counterparty` | `template_id` | `expected_day_of_month` | reconciles as               |
| ----------- | ------------------------------- | ------------- | ----------------------- | --------------------------- |
| `recurring` | optional (see OQ-1)             | set           | set (clamped)           | named if key, else category |
| `adhoc`     | **required** (decision 003-J)   | null          | optional                | always named                |
| `envelope`  | **must be null**                | null          | null                    | always category-level       |

These invariants are enforced in the Zod schemas and by the API on both `POST` and
`PATCH` — e.g. clearing an ad-hoc line's match key, or setting one on an envelope,
is rejected (`400`), because either would move the line into a behavior its kind
does not permit.

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

- **Materialization creates `recurring` lines only.** Envelopes are **never**
  auto-created — not from templates, not from the previous month, not from the
  prefill suggestion (decision 003-K). An envelope exists only because the owner
  confirmed an amount for that category in that month. This is what makes "does
  this month have envelopes?" a truthful answer to "did I budget this month?".
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
  deletable (amount, name, category, expected day, match key, note), subject to the
  per-`kind` invariants above. These edits are local to that month. The month itself
  also has an editable `note`.
- **Ad-hoc lines are always named** (decision 003-J): `POST` a `budget_line` with
  `kind='adhoc'`, `template_id=null`, and a **required**
  `match_normalized_counterparty`. An ad-hoc line exists to plan a _specific known
  charge_ this month ("June: car service at `AUTOKORJAAMO OY`"), so it always has a
  counterparty to consume.

  A planned one-off with **no known counterparty** is not an ad-hoc line — it is a
  **raised envelope** plus a note: set Transport's envelope to 550 with the note
  "incl. car service". This is the intended expression and the UI should say so
  when a user tries to add an ad-hoc line without a counterparty.

- **Envelope lines**: `kind='envelope'`, `template_id=null`, no match key, no
  expected day. **At most one envelope per category per month** (decision 003-B, as
  restated by 003-I) — the second one is rejected (`409`) and the user is steered to
  editing the existing envelope. An envelope's `category_id` is its identity;
  re-pointing it at a category that already has one gets the same `409`.
- **An envelope of 0 is not the same as no envelope.** `amount_cents = 0` is a
  deliberate goal ("spend nothing here this month"): the category has a line, so its
  spend reconciles against that line as overspend, and it does **not** appear under
  unbudgeted. No envelope at all means the category was left unplanned and its spend
  flows to unbudgeted. The budget-making screen must therefore distinguish an empty
  input from a typed `0`.
- **Creating/retargeting a template for an already-materialized month.** A month
  materializes exactly once (`uq_budgets_month`), so a template created — or made
  newly due — _after_ its month was materialized would otherwise not appear until
  the next fresh month. On create/edit, if the template is due in an
  already-materialized month that is the **current or a future** month, the API
  offers to insert its snapshot line into that month (a targeted insert, not a
  re-materialization). Already-closed past months are left as the historical
  record. Silently skipping the current month would read as a bug (review Q1).

### Reconciliation (planned vs. actual, per month)

Let **M** = the set of that month's transactions (by `payment_date`) that fall in
spec 004's **expense bucket** — i.e. excluding both `Transfer`-category
transactions and transactions in any **income-source** category
(`categories.is_income_source = true`), and **including** uncategorized rows
(`category_id is null`). This is the same three-bucket split 004 uses for cash
flow (decision 004-A), stated identically here on purpose: the two specs share a
tie-out (criterion 10), so they must share the definition (decision 003-F).

Income cannot participate in reconciliation at all — income budgeting is
deferred, so there are no income lines for a salary to reconcile against, and
leaving `PALKKA` in M would surface a +2826 € credit as "unbudgeted spending"
under Income. It is excluded from **both** sides of the tie-out.

1. **Named lines** (any line, `recurring` or `adhoc`, with a non-null
   `match_normalized_counterparty` — see decision 003-G: **`kind` is provenance,
   not behavior**): actual = sum of `M` rows whose
   `normalized_counterparty` equals the line's key. Matching is **strictly within
   the month** — a line only ever matches transactions in its own month; there is
   no fuzzy or adjacent-month matching. Matched transactions are **consumed**
   (removed from M) so they are not counted again below. If **no** M row matches
   (the expected charge is absent, or it posted in a different month), the line's
   actual is **0** and it is shown **pending / unmatched** — planned but not yet
   seen — never silently dropped or back-filled from a neighbouring month.
   **A named line matches by counterparty across categories, deliberately, and the
   line's category wins for reporting.** The line is about the _bill_, not the
   category. If a `Spotify`-keyed line sits in Subscriptions and you relabel a
   Spotify transaction to Entertainment, then: the named line still consumes it; the
   consumed amount is reported under **Subscriptions** (the line's category), not
   Entertainment; and Entertainment's envelope reconciles against a remainder that
   **excludes** it. This holds for both recurring and ad-hoc named lines. Every
   transaction is still consumed exactly once, so the month total is unaffected —
   only its per-category attribution follows the line (decision 003-G). See
   **Notes for the 004 revision**: this makes 003's per-category actual differ from
   a transaction-category breakdown, which 004 must address rather than inherit
   silently.

   **At most one line per match key per month** (decision 003-G). Two named lines
   with the same key — e.g. a materialized recurring line plus an ad-hoc that was
   patched onto the same counterparty — would both sum the same transactions, and
   "consumed" only disambiguates them if processing order is defined, which it
   deliberately is not. The API rejects the second one (`409`) on both `POST
.../lines` and `PATCH .../lines/:id`, steering to editing the existing line —
   the same medicine as 003-B.

2. **Category-level lines** — in practice **envelopes**, plus (provisionally) any
   `recurring` line that has no match key; see **OQ-1**. Actual = sum of the
   **remaining** M rows in that line's category. **At most one category-level line
   per category is allowed** (decision 003-B, restated by 003-I as "one envelope
   per category"): a category-level line reconciles against a whole category, so
   two of them competing for the same category's remainder would be ambiguous. The
   API rejects the second (`409`) and points the user at either editing the
   existing envelope or giving the new line a `match_normalized_counterparty`,
   which can freely coexist because it consumes only its own matched transactions
   in step 1.
3. **Unbudgeted spending**: remaining M rows in categories that have no line are
   surfaced as "unbudgeted" per category (so the month view reconciles to the full
   cash-flow expense total, not just budgeted categories).
4. **Needs review**: remaining M rows with `category_id is null` belong to no
   category, so step 3's "categories that have no line" does not cover them. They
   are surfaced as their own **"Needs review"** bucket alongside unbudgeted —
   never dropped. Dropping them would break the tie-out the moment anything is
   committed with `allowUncategorized` (spec 002), since 004 counts uncategorized
   rows as expenses (decision 003-F).

Variance per line = `plannedMagnitude − actualMagnitude` (both positive). Actual
is the absolute value of summed (negative) expense transactions; incoming refunds
in a category net down that category's actual.

### Per-category decomposition

Every line — named or envelope — carries a **required** `category_id`, and that
category is where the line's planned amount **and** its matched actuals are
reported (item 8; for named lines this is the line-category rule above). So for
any category **C** in a month:

- `plannedCents(C)` = C's envelope amount (0 if none) **+** Σ planned amounts of
  named lines whose `category_id = C`.
- `actualCents(C)` = Σ matched actuals of named lines in C **+** C's envelope
  remainder (the M rows still in C after step 1 consumption).

Summed over all categories, plus the unbudgeted and needs-review buckets, this
reproduces the month totals exactly — the decomposition is a partition, so no
transaction is counted twice and none is dropped.

**Calendar drift is visible on both sides (by design).** Because matching is strict
within-month, a bill that posts a month later than its line is due appears twice in
the reconciliation view — the due month's line reads _pending_ (no match), and the
actual month surfaces the charge under **unbudgeted** (no line covers it there).
This is deliberate: letting a line reach into adjacent months would hide the slip
and risk double-counting across two months' budgets. The owner sees the drift and
can adjust, rather than the number quietly absorbing it.

The month total (planned vs. actual vs. unbudgeted vs. needs-review) must
reconcile exactly with the cash-flow **expense** total for the same month computed
in spec 004 — a mismatch is a critical finding, not a footnote (CLAUDE.md
validation §6). Both sides must treat income and uncategorized rows **identically**:
income-source categories are excluded from both, and uncategorized rows are
included in both (here as "needs review", in 004 as expenses). When 004 is
implemented, check its expense-total definition against this **M** first — that
pair is where an inconsistency will try to live.

### Making the month's budget (envelope entry)

Materializing or opening a month presents the **budget-making** surface:

- It lists **all envelope-relevant categories**: every category except
  `is_income_source` ones and `Transfer` — the same exclusion as **M** above, so
  what you can budget for and what reconciles against it are the same set
  (decision 003-F). Archived categories are omitted unless they already have a
  line in this month.
- Each category has a **goal input**. Filling one in creates that category's
  `envelope` line; leaving it empty creates nothing.
- **Recurring lines materialize automatically as before** and are shown alongside
  their category's envelope input, so the owner can see what is already committed
  in that category before choosing a goal.
- **Leaving a category empty is a normal, deliberate choice — not a warning.**
  That category's spend simply flows to "unbudgeted". The UI must not badge,
  color, or count empty categories as a problem, and "unbudgeted" is neutral
  language for a normal state, not an error state (decision 003-K).

**Prefill is rendering-only.** Each goal input prefills with that category's
envelope amount from the **immediately preceding** calendar month (no deeper
lookback; if that month has no envelope for the category, the input is blank —
first month ever is therefore entirely blank). The prefilled value renders as an
**editable suggestion, visually distinct from a confirmed amount** (e.g. muted /
placeholder styling), and an untouched suggestion **creates no line**. Prefill
must never auto-create envelopes: doing so would make every month look budgeted
and destroy the "did I actually budget this month?" signal (decision 003-K).

**Double-planning is allowed but must be visible.** A one-off can legitimately be
planned twice — a named ad-hoc line for the car service _and_ a raised Transport
envelope. Nothing rejects this (the named line consumes its charge, the envelope
takes the remainder, and the tie-out still holds), but the plan is then double-
counted against the owner's intent. The budget-making screen therefore shows a
**per-category planned subtotal** — `plannedCents(C)` above, i.e. envelope + named
lines in that category — next to each goal input, so the doubling is visible at a
glance rather than discovered at month end.

## API surface

- `GET /api/budgets/:month` → the budget with lines, each line's computed actual +
  variance, the **per-category decomposition** (planned subtotal, actual, envelope
  vs. named split), plus `unbudgeted` and `needsReview` sections. Also returns
  `envelopeCandidates`: one entry per envelope-relevant category with
  `{ categoryId, envelopeAmountCents | null, suggestedAmountCents | null }`, where
  `suggested` is the previous month's envelope amount. **A suggestion is data for
  rendering, never a line** (decision 003-K). Auto-materializes the **current**
  month and any month the user explicitly opens; other absent months return an
  uncreated marker rather than being materialized on a glance (decision 003-C).
- `POST /api/budgets` `{ month }` → materialize explicitly (recurring lines only).
- `PATCH /api/budgets/:month` `{ note? }` → edit the month-level note.
- `PUT /api/budgets/:month/envelopes` `{ envelopes: [{ categoryId, amountCents }] }`
  → the budget-making screen's save. **Upsert** semantics: creates or updates an
  envelope per listed category; a listed `amountCents: null` **deletes** that
  category's envelope; **categories omitted from the array are left untouched**
  (so a partial save can never silently wipe envelopes the screen didn't render).
  Rejects income-source and `Transfer` categories (`400`).
- `POST /api/budgets/:month/lines` → add a line.
  - `{ kind:'adhoc', name, categoryId, amountCents, matchNormalizedCounterparty,
expectedDayOfMonth?, note? }` — match key is **required** (`400` without it, with
    a message pointing at raising the category's envelope instead); `409` if the
    month already has a line with that key.
  - `{ kind:'envelope', categoryId, amountCents, note? }` — no match key, no
    expected day (`400` if either is supplied); `409` if the category already has
    an envelope this month. (Equivalent to a one-category `PUT`; the bulk endpoint
    is what the budget-making screen uses.)
- `PATCH /api/budgets/:month/lines/:id` `{ …, matchNormalizedCounterparty?, note? }`
  → edit a line (incl. note). The per-`kind` invariants hold on `PATCH` exactly as
  on `POST`: clearing an ad-hoc line's match key or setting one on an envelope is
  `400`; a patch that would create a duplicate match key in the month, or a second
  envelope in a category, is `409`. A patch can therefore never reach a state the
  corresponding `POST` would have rejected.
- `DELETE /api/budgets/:month/lines/:id` → delete a line.
- Templates CRUD: `GET/POST /api/recurring-templates`,
  `PATCH/DELETE /api/recurring-templates/:id`. **`DELETE` succeeds only for a
  template that has never materialized a line**; if any `budget_lines.template_id`
  still references it, the API returns `409` and steers the user to setting
  `end_month` instead ("end, don't delete" — decision 003-H). Fields: `name`, `categoryId`,
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
  the line now (review Q1). The primary retirement action is **End** (set
  `end_month`); **Delete** is offered only for a template with no materialized
  lines, and a rejected delete explains why and offers to end it instead.
- **Budget-making screen** (opening/materializing a month): one row per
  envelope-relevant category — category name, any **recurring lines already
  materialized** into it (name + amount, read-only here), a **goal input**, and the
  **per-category planned subtotal** (envelope + named lines) so double-planning is
  visible. Prefilled suggestions render muted/placeholder-styled, clearly distinct
  from a confirmed amount; typing confirms, and an untouched suggestion saves
  nothing. Empty rows are styled as ordinary, not as warnings — no badge, no count
  of "unbudgeted categories", no nag (decision 003-K). One save action
  (`PUT …/envelopes`).
- **Month view**: a month picker; lines grouped as **Bills** (recurring), **One-offs**
  (ad-hoc) and **Envelopes**, each row showing planned, actual, variance, a small
  day-of-month marker (bills only), and an optional per-line note; color/no-judgment
  bar showing actual vs planned. Named-line rows indicate that they match by
  counterparty, so an amount appearing under a category the transaction isn't
  labeled with is explicable rather than a mystery. An "Unbudgeted" group lists
  categories with spending but no line — neutral framing, it is a normal state — and
  a **"Needs review"** group lists the month's uncategorized transactions with a
  link into the transaction list to label them. A month-level note field sits at the
  top. Buttons: "Add one-off (needs a counterparty)", "Edit goals" (back to the
  budget-making screen), "Materialize month" (if not yet created). A month footer
  totals planned vs. actual and shows the reconciliation tie-out to cash flow.
- **"Not budgeted yet" signal**: a month with **zero envelope lines** is shown as
  not yet budgeted (informational, on the month view header) — the signal decision
  003-K exists to protect. It states a fact; it does not scold.

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
   those transactions are not double-counted in that category's envelope.
7. An **envelope** reconciles to its category's remaining transactions (after named
   lines consume theirs); a category with spend but **no** line appears under
   "unbudgeted".
8. `expected_day_of_month = 31` clamps correctly in 30-day and February months.
9. A template's `note` is snapshotted onto its materialized line; editing the
   line's note afterward does not change the template, and editing the template's
   note does not change already-materialized lines (same snapshot rule as amounts).
10. Month planned/actual/unbudgeted/needs-review totals reconcile with spec 004's
    cash-flow **expense** total for the same seed and month, with **both sides
    treating income and uncategorized identically**: the seeded monthly `PALKKA`
    salary (+2826 €) appears in **neither** side's expense figure and in no
    unbudgeted bucket, and uncategorized rows are counted by both.
11. **Uncategorized surfaces, tie-out holds.** A transaction committed with
    `allowUncategorized` (spec 002) in month M appears in M's **"Needs review"**
    bucket with its amount, and criterion 10's tie-out still holds for M with it
    included. Labeling it into a category moves it out of needs-review into that
    category's line or unbudgeted, and the tie-out holds again — the total does
    not change.
12. **Named-ness follows the match key, not `kind`.** `PATCH`-ing a
    `match_normalized_counterparty` onto a keyless **recurring** line makes it
    reconcile as a **named** line (consuming its matched transactions in step 1)
    rather than at category level, and clearing it again reverts it. The same patch
    against an **envelope** is rejected (`400`), and clearing an **ad-hoc** line's
    key is rejected (`400`) — the per-`kind` invariant table holds under `PATCH`.
    _(If **OQ-1** resolves toward requiring match keys on templates, the keyless-
    recurring half of this criterion disappears and only the two `400` cases
    remain.)_
13. **Duplicate match key rejected.** Adding or patching a second line with a
    match key the month already has returns `409` (e.g. an ad-hoc line patched to
    the same counterparty as a materialized recurring line), and the month's
    reconciliation is unchanged by the rejected call.
14. **Named line crosses categories; the line's category wins for reporting.**
    Relabeling a transaction matched by a named line into a different category
    leaves the named line's actual unchanged; the consumed amount is reported under
    the **line's** category, not the transaction's; the new category's envelope
    reconciles against a remainder that **excludes** it; and the month total is
    unchanged by the relabel. Asserted for both a recurring and an ad-hoc named
    line.
15. **Template delete is blocked once materialized.** `DELETE` on a template with
    at least one materialized `budget_line` returns `409` and leaves both the
    template and its lines intact; setting `end_month` instead stops future
    materialization while past months keep their lines. `DELETE` on a template
    that never materialized a line succeeds.
16. **Absent due-month.** A monthly template matched to the seeded `ELIXIA HELSINKI`
    gym shows 2026-02 as **pending / unmatched** (planned, actual 0) while the other
    eleven months reconcile; asserts against
    `expected.json → recurringNegativeCases.absentDueMonth`.
17. **Calendar drift.** A yearly template matched to `AUTOLIITTO`, anchored to its
    nominal due month (2026-02), leaves that month **pending** (no Feb charge), and
    the real charge in 2026-03 surfaces as **unbudgeted** there — strict matching
    does not reach across months; asserts against
    `recurringNegativeCases.driftedYearly`.
18. **Envelope basics.** Creating an envelope for a category produces a line with
    `kind='envelope'`, null match key, null expected day, null `template_id`; a
    second envelope in the same category that month returns `409` and leaves the
    first intact. Supplying a match key or expected day on an envelope is `400`.
19. **Ad-hoc lines must be named.** `POST` of an ad-hoc line **without**
    `matchNormalizedCounterparty` returns `400` and creates nothing; the same line
    **with** a counterparty is created and reconciles as a named line. (The
    no-counterparty case is expressed as a raised envelope + note instead — the
    error message says so.)
20. **Prefill creates nothing.** Given month M−1 with a Groceries envelope of
    40000, opening M returns `suggestedAmountCents: 40000` for Groceries with
    `envelopeAmountCents: null`, and M has **zero** envelope lines until a save.
    Opening and leaving M untouched leaves M with no envelope lines (asserted at
    the DB level, not just the UI). The first month ever has no suggestions at all.
21. **Envelope 0 ≠ no envelope.** A category with an explicit 0 envelope and spend
    in the month reconciles against that line (full overspend variance) and does
    **not** appear under "unbudgeted"; the same category with no envelope at all
    appears under "unbudgeted". The month tie-out holds in both cases.
22. **Per-category decomposition and visible double-planning.** For a category with
    both a named ad-hoc line (e.g. car service) and an envelope, the screen's
    per-category planned subtotal equals envelope + named line amounts, and the
    category's actual equals the named line's matched sum + the envelope's
    remainder. Σ over categories + unbudgeted + needs-review equals the month
    totals (the partition holds).
23. **Envelope-relevant category set.** The budget-making surface offers goal
    inputs for exactly the categories in **M**'s scope — income-source categories
    and `Transfer` are absent — and `PUT …/envelopes` rejects them (`400`).
24. **Bulk save is a partial upsert.** `PUT …/envelopes` creates/updates the listed
    categories, deletes one sent with `amountCents: null`, and leaves an envelope
    for a category **omitted** from the payload untouched.
25. Playwright screenshot of (a) the budget-making screen with prefilled
    suggestions visually distinct from confirmed amounts and at least one
    deliberately empty category, and (b) the month view with reconciled numbers
    visible (including the "Needs review" bucket).

> **Test data (done).** The synthetic fixtures seed the charges these criteria
> reconcile against. **Happy path** (`expected.json → recurringNonMonthly`): a
> **yearly** home-insurance E-LASKU (`LÄHITAPIOLA`, −600 € once in 2025-10) and a
> **quarterly** self-storage KORTTIOSTO (`PELICAN SELF STORAGE`, −87 € in
> Jul/Oct/Jan/Apr). **Negative cases** (`recurringNegativeCases`) that validate
> strict matching: an **absent due-month** (the monthly `ELIXIA HELSINKI` gym is
> present 11 months but skips 2026-02) and a **drifted yearly** bill (`AUTOLIITTO`,
> nominally due 2026-02 but posted 2026-03). All are named lines (normalize to
> themselves).
>
> **Still needed for criterion 11:** `expected.json` has no uncategorized-row
> expectation yet. The needs-review criterion requires at least one seeded month
> with a transaction committed under `allowUncategorized`, plus that month's
> expense total including it — add a `needsReview: { month, amountCents,
counterparty }` block alongside `recurringNegativeCases` when implementing.
>
> **Envelope criteria (18–24) need no new fixtures.** Envelopes are user-created,
> not seeded — those tests build their own envelopes over the existing seeded
> transactions. Criterion 22 reuses any seeded counterparty for its ad-hoc line.

## Deferred (needs a new approved spec)

- **Income budgeting** (templates and envelopes are expenses only — CLAUDE.md
  deferred list).
- Budget rollover / carry-over of under/overspend between months. An envelope is
  a single month's goal; an unspent envelope does **not** increase next month's.
- **Sinking funds** (accruing a monthly reserve toward a future non-monthly bill —
  003-E option b). Distinct from envelopes; see the naming note under 003-E.
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
  remainder — no ambiguity. _Restated by 003-I (2026-07-18):_ the category-level
  line is now the category's **envelope**, so this reads "**one envelope per
  category per month**" (plus, provisionally, any keyless recurring line — see
  OQ-1).
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
  active templates (spec 004). **Sinking funds** (option b) are deferred to their
  own spec. _Naming note (2026-07-18):_ this decision originally called those
  "sinking-fund envelopes". They are **not** the `kind='envelope'` lines added by
  003-I and share no mechanism: a sinking fund would **accrue a monthly reserve
  toward a future non-monthly bill**, whereas an envelope is a **single month's
  goal for a category**, never carried forward. The word "envelope" in this spec
  now means only the latter; the deferred concept is called a **sinking fund**.

## Resolved decisions (owner, 2026-07-18 — spec review)

- **003-F — What reconciliation is _over_ (the M definition).** ✅ **M = spec 004's
  expense bucket**: excludes `Transfer` **and** every `is_income_source` category,
  **includes** `category_id is null`, which surfaces as a dedicated **"Needs
  review"** bucket rather than being dropped. _Context:_ as originally drafted M
  excluded only Transfer, so the seeded monthly `PALKKA` (+2826 €) reached step 3
  and landed under "unbudgeted spending" in an expenses-only budget — nonsense,
  and a guaranteed break of the criterion-10 tie-out. Uncategorized rows had the
  mirror problem: in M, in no category, and invisible to step 3's "categories with
  no line", so they'd silently vanish from reconciliation while 004 counts them as
  expenses. Both sides of the tie-out now treat income and uncategorized
  identically. This is pinned rather than left implicit because the fixtures make
  it bite on the **first** reconciled month, where an implementing agent would
  otherwise resolve the contradiction silently in whatever direction its own tests
  suggested.
- **003-G — Named-ness is the match key, not `kind`.** ✅ A line is **named** iff it
  carries a `match_normalized_counterparty`; `kind` records provenance
  (materialized-from-template vs. ad-hoc) and has no reconciliation behavior.
  _Context:_ step 2 originally classified by kind, but `PATCH` can put a match key
  on any line and the column exists on all of them, so a patched ad-hoc line
  contradicted the classification. Ad-hoc `POST` therefore also takes a match key —
  and as of 003-J **requires** one. Two consequences pinned with it: (a) **at most
  one line per match key per month** — two named lines on the same key would both
  sum the same transactions and "consumed" only disambiguates them under a defined
  processing order, which there isn't; second one gets a `409`, same steering as
  003-B; (b) a named line **matches across categories, and the line's category wins
  for reporting** — relabeling a Spotify charge to Entertainment leaves the Spotify
  line consuming it, the amount reported under the line's category, and
  Entertainment's envelope remainder excluding it. The named line is about the
  _bill_, not the category; consumption keeps the tie-out exact. Deliberate, and
  documented so it is not discovered as a surprise.
- **003-H — Retiring a template: end, don't delete.** ✅ `DELETE
/api/recurring-templates/:id` succeeds **only** when no `budget_line` references
  the template; otherwise `409` steering to `end_month`. _Context:_
  `budget_lines.template_id` references `recurring_templates.id` with **no**
  `ON DELETE` behavior (`schema.ts:333`) and `PRAGMA foreign_keys = ON` is set on
  every connection (`db/client.ts:25`), so the endpoint as offered would have
  failed at the FK for every template that ever materialized a line — i.e. nearly
  all of them. Rejected alternative: a forward migration to `ON DELETE SET NULL`
  (the 002-F pattern, since 001 is merged and its migration is not amended). Ending
  is preferred: it matches the snapshot philosophy — past months are a historical
  record — and keeps line provenance intact, which `SET NULL` would erase. No
  migration is needed for this spec.

## Resolved decisions (owner, 2026-07-18 — envelope redesign)

- **003-I — Envelopes are per-month category goals.** ✅ A third
  `budget_lines.kind = 'envelope'`: a rough planned amount for a **category** in a
  **single month**, set by hand, expected to change month to month, never
  materialized from anything and never carried forward. Category-level by
  definition (null match key, null expected day, null `template_id`), **one per
  category per month** — which is now the concrete form of 003-B's invariant.
  _Context:_ templates are **bills** (fixed amount, cadence, due day, usually a
  counterparty); expressing "I want to spend about 400 on groceries" as a template
  abused that model — a goal has no cadence to be due on and no counterparty to
  match. Splitting the two instruments makes the reconciliation taxonomy exactly
  two behaviors instead of three overlapping ones. TS enum change only; `kind` is
  unconstrained `text` in migration `0000`, so **no SQL migration**.
- **003-J — Ad-hoc lines require a counterparty.** ✅ Option (a).
  `kind='adhoc'` now requires a non-null `match_normalized_counterparty` (`400`
  otherwise). _Context:_ once envelopes exist, a keyless ad-hoc line is just a
  worse envelope — it would be a second category-level claimant on the same
  category, reintroducing exactly the 003-B ambiguity. A planned one-off with no
  known counterparty is expressed as a **raised envelope + note** ("Transport 550,
  note: incl. car service"). The payoff is the two-behavior taxonomy: named lines
  consume their counterparty, envelopes take the remainder.
- **003-K — Prefill is rendering-only; empty is normal.** ✅ Goal inputs prefill
  from the immediately preceding month's envelope for that category, rendered as a
  visually distinct **suggestion**; envelopes are created **only** on confirmation.
  _Context:_ auto-creating envelopes from the previous month would make every month
  look budgeted and destroy the "did I budget this month?" signal — the zero-envelope
  state is the signal, so nothing may manufacture envelopes behind the owner's back.
  Paired UI-tone decision: a category left without an envelope is a **normal,
  deliberate choice**; its spend flows to "unbudgeted", which is neutral reporting
  language, not a warning. No badges, no nag counts.

## Notes for the 004 revision (do not edit 004 from this spec)

1. **Expense-total definition must match M** (from 003-F). 004's cash-flow expense
   total is one side of criterion 10's tie-out: it must exclude `Transfer` and all
   `is_income_source` categories and **include** uncategorized rows. 004's current
   Definitions section (`004-dashboard.md:19-26`) already says exactly this, so
   today they agree — the note is to keep them agreeing, and to re-check on any
   004 edit.
2. **Per-category breakdown now diverges from 003 by design** (from item 5/8, new).
   003 reports a named line's matched amount under the **line's** category; a
   transaction-category breakdown (what 004's spending-by-category view would
   naturally compute) reports it under the **transaction's** category. After a
   relabel these two per-category numbers legitimately differ while the **totals**
   still agree. 004 must state which attribution its category chart uses and
   acknowledge the divergence, rather than inheriting 003's rule silently or
   tripping CLAUDE.md §6 over a difference that is not a bug. See **OQ-2**.

## Open questions (owner to rule — do not implement past these)

- **OQ-1 — May a `recurring` template still have no match key?** The schema allows
  it and 003-D calls the key optional, but item 7's taxonomy ("named lines consume
  their counterparty; envelopes take the remainder") has no room for a third,
  keyless-recurring behavior. If keyless recurring lines persist, they are a second
  category-level claimant and collide with that category's envelope — the exact
  ambiguity 003-B and 003-J exist to prevent. **Provisionally** this spec keeps
  them working and folds them into 003-B's one-category-level-line-per-category
  rule (so a keyless recurring line blocks that category's envelope, and vice
  versa). **Recommendation: require `match_normalized_counterparty` on templates**
  — a bill has a counterparty by definition, and the "template without a
  counterparty" use case is now served better by an envelope. That would be a
  Zod/API-level requirement; the column stays nullable, so still no migration. It
  changes 003-D's "optional" wording, so it is the owner's call, not mine.
- **OQ-2 — Which attribution does 004's category breakdown use?** Line-category
  (consistent with 003's month view) or transaction-category (consistent with "where
  did the money actually go")? **Recommendation: transaction-category in 004**, with
  the divergence documented on both sides — the two views answer different
  questions, and forcing 004 to adopt line-attribution would make the dashboard's
  category chart depend on budget configuration. Needs a ruling before 004 is
  implemented.
