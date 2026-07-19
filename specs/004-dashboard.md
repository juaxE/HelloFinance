# Spec 004 — Dashboard (overview)

Status: **approved** (owner, 2026-07-18) — ready to implement.
Depends on: 001 (schema), 002 (transactions), 003 (budget reconciliation).
Depended on by: nothing.

## Purpose

The at-a-glance overview: **net worth trend**, **monthly cash flow**
(income − expenses, transfers excluded), **income sources** (salary vs other),
**per-category expense breakdown**, **budget vs. actual for the current month**,
and **asset-snapshot entry** for investments / loans (the emergency fund is a bank
account, not an asset). All figures are computed by the API from the
same committed data the other views use; the UI only formats at the edge
(`1 234,56 €`). UI numbers must reconcile with API numbers for the same seed
(CLAUDE.md validation §6).

## Definitions (single source of truth for aggregates)

Let a transaction's **month** be its `payment_date` month. Categories fall into
three buckets (decision 004-A):

- **Transfer** (`system_key='transfer'`) — excluded from every aggregate.
- **Income-source** (`is_income_source=true`; the Income built-in, plus any user
  income category) — counts as income.
- **Expense** (everything else, including **Uncategorized** = `category_id null`).

Income is **category-driven**, not sign-based, so the three income sources the
owner wants to tell apart are distinguishable:

- **Salary** = amounts in the **Income** category (PALKKA auto-labels here via the
  type hint).
- **Other income** = amounts in other **income-source** categories (e.g. a future
  "Other income" / Kela benefit category).
- **Reimbursements** (people paying back their share) = a positive amount
  categorized into an **expense** category. It is _not_ income — it nets that
  category down (split a €40 dinner, get €20 back → Restaurants shows €20). If you
  want to see paybacks as their own line, categorize them into a dedicated
  category (e.g. "Reimbursements"); left in the original expense category, they
  simply reduce it.

Definitions:

- **Monthly income** = Σ `amount_cents` in income-source categories.
- **Monthly expenses** = −Σ `amount_cents` in expense categories (so reimbursement
  positives reduce it; a refund-heavy category nets toward zero).
- **Monthly net cash flow** = income − expenses.
- **Income breakdown** (a month) = per income-source category, its total → gives
  Salary vs Other income; reimbursements surface as negative offsets within the
  category breakdown.
- **Per-category expense** (a month) = per expense category, −Σ of amounts, a
  positive magnitude, attributed by the **transaction's own** category (see the
  divergence note below).
- **Account balance at date D** = `opening_balance_cents` +
  Σ `amount_cents` for that account with
  `opening_balance_date ≤ payment_date ≤ D` (the lower bound is dropped when
  `opening_balance_date` is null). This is the pinned opening-balance boundary from
  decision 001-A — it is what stops back-filled history from double-counting, and
  the net-worth formula below inherits it through this definition.
- **Net worth at month M** (end of month) — see the net-worth formula below.

### Per-category attribution diverges from spec 003 — by design (003-M)

This spec's category breakdown attributes every transaction to **its own
category**: the dashboard answers "_where did the money go_". Spec 003's month
view attributes a named budget line's matched amount to the **line's** category
(decision 003-G): it answers "_how did my plan do_". The two therefore disagree
per category after a relabel. Concretely: a `SPOTIFY`-keyed named line sits in
Subscriptions and the Spotify transaction is relabeled to Entertainment — 004's
breakdown moves that amount to **Entertainment**, while 003's per-category
decomposition still reports it under **Subscriptions** (the line consumed it, and
the line's category wins there). Both sides' **month totals are unchanged and
equal**, which is exactly what criteria 2, 5 and 7 assert.

A per-category difference between this dashboard and the Budgets month view is
**not** a CLAUDE.md §6 tie-out violation and must not be "reconciled" by making
either side adopt the other's attribution. In particular, 004 must not inherit
003's line-attribution: that would make the dashboard's spending chart change
whenever a budget line is added, deleted or re-categorized — reporting mutated by
planning configuration. §6 binds the **totals**, not the per-category split.

### Net worth, snapshots and archiving

```text
netWorth(M) =  Σ account_balance(account, monthEnd(M))   over all accounts (incl. the buffer / emergency fund)
             + Σ latest snapshot with month ≤ M           for kinds {investment, other}
             − Σ latest snapshot with month ≤ M           for kind loan
```

The emergency fund is the **buffer Account**, so its balance is already in the
account term — it is not a separate asset (decision 001-D). Snapshots are carried
forward: the latest one with `month ≤ M` (decision 004-B) — so a month with no new
snapshot reuses the last entered value instead of dropping to zero.

**Archiving an asset never rewrites net-worth history (decision 004-F).**
`assets.archived_at` removes the asset from the **snapshot-entry form only**. Its
existing snapshots keep carrying forward into every month `≥` their own, exactly
as before — net worth in a past month must never change because of an action taken
today. Ending an asset's contribution is therefore a **data** step, not an archive
step: enter a **final snapshot** first, then archive. For a paid-off loan that
final snapshot is `0` in the month it was settled; for a liquidated investment it
is `0` in the same month the proceeds land in a bank account, so the account term
picks up what the asset term drops and the trend stays continuous. An archived
asset whose last snapshot is non-zero **keeps contributing** — a "phantom loan" is
a faithful report of the data that was entered, and the fix is to enter the
closing snapshot, never to filter archived assets out of the net-worth query.

### Months before an account existed (004-E)

The balance formula's window is empty for a `monthEnd(M)` earlier than an
account's `opening_balance_date`, which would otherwise return the bare
`opening_balance_cents` and paint a flat, plausible-looking, wrong line backwards
in time. Two rules:

- An account contributes **0**, not its opening balance, to any month whose
  `monthEnd(M) < opening_balance_date`. An account with a null
  `opening_balance_date` has no lower bound and contributes for every month.
- Trend endpoints **clamp** their start to the month containing the **earliest**
  `opening_balance_date` across accounts (no clamp if every account's is null).
  A requested `window` or `from` reaching further back simply returns fewer
  points — a 12-month window on young data shows the months that exist.

Months inside the window in which some account is not yet open are flagged
`partialAccounts: true` in the response, and the chart marks that segment (the
step up when a second account starts being tracked is real, and must not read as
a windfall).

### Normalized monthly commitments (003-E)

**Normalized monthly commitments** (read-only planning indicator) = Σ over
recurring templates active this month of `round(amount_cents / interval_months)`.
It smooths non-monthly bills into a monthly-equivalent figure — a 600 €/yr
insurance counts as ~50 €/mo, an 87 €/qtr storage fee as 29 €/mo — so the reader
sees their true ongoing commitment without the calendar spikes. It is **display
only**: it never enters budgets, reconciliation, or net worth (those use real
transactions), so per-template rounding to whole cents is harmless. `round` is
**half-up, away from zero**, on the cent, applied **per template** before summing
(not to the sum) — pinned so the figure is reproducible rather than whatever the
implementation's default happens to be. "Active this month" =
`start_month ≤ current ≤ end_month` (end open ⇒ ongoing).

## API surface

Read endpoints (all return integer cents; UI formats). Trend endpoints accept a
`window` of `3 | 6 | 9 | 12` months ending at the current month (default `12`),
or an explicit `from`/`to` (decision 004-C):

- `GET /api/dashboard/net-worth?window=12` (or `?from=&to=`) →
  `[{ month, accountsCents, investmentsCents, loansCents, netWorthCents }]`
  (the buffer/emergency-fund balance is inside `accountsCents`).
- `GET /api/dashboard/cash-flow?window=12` →
  `[{ month, incomeCents, expensesCents, netCents }]`.
- `GET /api/dashboard/income?month=YYYY-MM` →
  `{ salaryCents, otherIncomeCents, byCategory: [{ categoryId, name, amountCents }] }`
  (income-source breakdown — salary vs other income).
- `GET /api/dashboard/categories?month=YYYY-MM` →
  `[{ categoryId, name, color, amountCents }]` for expense categories, sorted desc
  by magnitude; reimbursement-heavy categories can go negative.
- `GET /api/dashboard/budget-vs-actual?month=YYYY-MM` → summary delegating to
  spec 003 (per-line + totals), shaped for the dashboard card.
- `GET /api/dashboard/recurring-commitments` →
  `{ normalizedMonthlyCents, byTemplate: [{ templateId, name, amountCents,
intervalMonths, monthlyEquivalentCents }] }` — the read-only normalized monthly
  commitments indicator for the current month (decision 003-E).

Asset management + snapshot entry:

- `GET /api/assets`, `POST /api/assets` `{ name, kind }`,
  `PATCH /api/assets/:id` (rename/archive). Archiving sets `archived_at`; it does
  **not** touch snapshots and does not change any past or future net-worth figure
  (decision 004-F).
- `GET /api/asset-snapshots?month=YYYY-MM` → current values for that month (with
  carry-forward indicator). Returns **non-archived** assets only — this is the
  entry form's source. The net-worth endpoint ignores `archived_at` entirely.
- `PUT /api/asset-snapshots` `{ month, values: [{ assetId, valueCents }] }` →
  upsert the month's snapshot per listed asset (unique on `(asset_id, month)`).
  **Partial-upsert semantics, same as `PUT …/envelopes` in 003**: creates or
  updates a snapshot per listed asset; **assets omitted from the array are left
  untouched** (a partial save can never silently wipe or zero a snapshot the
  screen didn't render). There is no delete-by-omission — clearing an asset's
  contribution is an explicit `valueCents: 0`, which is a real snapshot and
  carries forward like any other. Rejects an **archived** asset (`400`): enter the
  final snapshot before archiving.

## UI sketch

A single dashboard route, responsive card grid (Recharts for charts):

- **Net worth trend** (line/area): total net worth, with a breakdown toggle
  (accounts / investments / −loans; the buffer/emergency fund is part of accounts)
  and a window selector **3 / 6 / 9 / 12 months** (default 12). Reads `/net-worth`.
  A window reaching before the earliest account opening date renders fewer points,
  not padded ones (decision 004-E); months flagged `partialAccounts` are marked so
  the step where a second account starts being tracked doesn't read as a windfall.
- **Cash flow** (grouped bars per month: income vs. expenses; a net line): same
  window selector; transfers excluded; reads `/cash-flow`.
- **Income sources** (current month): salary vs other income split (and
  reimbursements shown as offsets); reads `/income`.
- **Category breakdown** (current month; horizontal bars or donut): expense
  category magnitudes, "Uncategorized" as its own slice, marked "needs review";
  reads `/categories`.
- **Budget vs. actual** (current month): compact planned/actual/variance list or
  progress bars; links to the full Budgets month view (003); reads
  `/budget-vs-actual`.
- **Recurring commitments** (stat tile): "≈ X €/mo" normalized monthly commitments
  (decision 003-E), with each active template's monthly-equivalent on expand.
  Clearly labeled an estimate (it smooths quarterly/yearly bills); links to the
  Budgets templates view; reads `/recurring-commitments`.
- **Asset snapshot entry**: a small form/modal listing each asset with the current
  month's value pre-filled (carried forward if not yet entered); Save `PUT`s the
  month's snapshot. Loans are entered as positive balances and shown subtracted in
  net worth. Archived assets are **not listed** (decision 004-F); the archive
  action warns that a non-zero last value keeps carrying forward and offers to
  enter a closing `0` first — which is the intended way to retire a paid-off loan
  or a liquidated investment.

The "current month" cards (income sources, category breakdown, budget vs. actual)
show the current, still-partial month labeled **"month to date"** (decision
004-D).

Formatting: EUR with non-breaking-space thousands and decimal comma
(`1 234,56 €`) — a shared `formatEur(cents)` helper in `@finance/shared`, applied
only at render.

## Acceptance criteria

Assert against `fixtures/expected.json` (CLAUDE.md validation §5, §6):

1. Cash flow for a seeded month excludes `Transfer` / `OMA TILISIIRTO` (verify a
   month containing transfers is unaffected). The `incomeSourcesMain` breakdown in
   `expected.json` ties out: salary (PALKKA) is separated from other inflows.
2. Category breakdown sums, across expense categories, to the month's expense total
   from the cash-flow endpoint (internal reconciliation); a positive reimbursement
   reduces its category's magnitude.
3. Net worth for a seeded month equals opening balances + summed transactions +
   asset snapshots − loans; adding a later loan snapshot decreases net worth by the
   loan amount.
4. Carry-forward: a month with no new asset snapshot uses the most recent prior
   snapshot per asset.
5. Budget-vs-actual totals equal spec 003's reconciliation for the same month.
6. Normalized monthly commitments = Σ `round(amount_cents / interval_months)` over
   templates active in the month, rounding **half-up per template**: a 600 €/yr +
   an 87 €/qtr + a 1000 €/mo + a **1000 €/yr** template → 5000 + 2900 + 100000 +
   **8333** = 116233 cents. The 1000 €/yr template is non-divisible
   (100000 / 12 = 8333.33…) and pins truncation-vs-rounding; a template landing
   exactly on half a cent rounds **away from zero** (12,33 € every 2 months →
   1233 / 2 = 616.5 → **617**). The figure is the same in every month regardless
   of which charge is due, and it does not affect the cash-flow or budget totals.
7. **003-M divergence holds, and the totals still tie out.** With a `SPOTIFY`-keyed
   named line in **Subscriptions** consuming a Spotify transaction, relabel that
   transaction to **Entertainment**, then re-read both views for the month:
   - 004's `/dashboard/categories` moves the amount from Subscriptions to
     Entertainment (transaction-category attribution);
   - 003's per-category decomposition still reports it under Subscriptions (the
     line's category);
   - **both sides' month expense totals are unchanged by the relabel and equal to
     each other.**
   This is the test that pins the ruling: a diff in the per-category split with
   matching totals is the specified behavior, not a §6 finding.
8. **Archived asset keeps contributing.** Archive an asset whose last snapshot is
   non-zero → net worth for every month, past and future, is **byte-identical** to
   before the archive; the asset disappears from `GET /api/asset-snapshots` and
   `PUT` on it returns `400`. Then the intended flow: enter a final `0` snapshot
   for a loan in month M **before** archiving → net worth rises by the loan
   balance from M onward and **months before M are unchanged**.
9. **Pre-opening months.** For an account with `opening_balance_date` in month K:
   a trend request whose window reaches before K returns no points before the
   earliest opening date across accounts (clamped), and for any returned month
   `< K` that account contributes **0** — asserted explicitly, since the bug this
   guards against (opening balance rendered flat backwards) looks correct.
   Months where an account is not yet open carry `partialAccounts: true`.
10. **UI ↔ API tie-out**: the numbers rendered on the dashboard (read from the
    Playwright DOM) equal the API responses for the same seed — asserted, not
    eyeballed.
11. Playwright screenshot of the dashboard with seeded data visible in every card.

### Test-construction notes (criteria 7 and 8)

Two of the criteria above have a failure mode in the **test**, not the
implementation. Carry these into the implementation prompt's test rules.

- **Criterion 7 must relabel with `scope: 'one_off'`.** The relabel goes through
  `PATCH /api/transactions/:id`, and spec 002's `update_rule` scope is
  **retroactive**: it upserts the labeling rule and relabels every committed
  transaction sharing that `normalized_counterparty` whose
  `category_source='rule'` (002 criterion 13). On a seed with a monthly Spotify
  charge that silently moves **every** month's breakdown, not the one under test,
  and the failure surfaces as an unrelated assertion three months away. Use
  `one_off` — it sets `category_source='manual'` and leaves rules untouched, which
  is exactly the single-transaction relabel the criterion describes. The test also
  constructs the `SPOTIFY`-keyed named line (template or ad-hoc) in Subscriptions;
  the seed is not required to ship one. Assert the neighbouring months' breakdowns
  are **unchanged** as the guard that the scope was right.
- **Criterion 8's "byte-identical" means wholesale comparison.** Capture the
  **entire** `/dashboard/net-worth` response over the full available window before
  archiving, and deep-equal it against the same request after. Do not reduce this
  to spot-checking a month or two: the regression it guards against — excluding
  archived assets from the net-worth query — shifts every month from the asset's
  first snapshot onward, and a spot check picks the wrong months roughly as often
  as the right ones. The subsequent closing-`0`-snapshot step asserts the
  complement: months `≥ M` move by the loan balance, months `< M` deep-equal the
  captured baseline.

## Implementation notes

Choices made where the spec was silent on a detail. Each is the simplest option
consistent with the existing code; none changes a behavior the spec pins.

- **`partialAccounts` is on the net-worth response only.** The spec introduces
  the flag under the net-worth section, and it is a statement about account
  *balances*. Cash flow has no opening-balance term, so the flag would mean
  nothing there. Both endpoints do clamp, since the spec says "trend endpoints".
- **Any account with a null `opening_balance_date` suppresses the clamp.** The
  spec pins "no clamp if every account's is null" and separately that such an
  account "has no lower bound and contributes for every month". The mixed case
  follows from the second rule: one unbounded account makes every requested
  month meaningful.
- **`GET /dashboard/budget-vs-actual` never materializes a month.** It returns
  `materialized: false` with an empty planned side and the month's real
  `expenseCents` (computed over 003's same set M, so the cash-flow tie-out holds
  either way). Materializing on a glance would violate decision 003-C.
- **The UI takes "the current month" from the server**, via the month the
  commitments endpoint reports, not from the browser clock — otherwise a pinned
  server clock and the browser's real one would disagree about which month the
  "month to date" cards show.
- **`FINANCE_NOW`** (new, `packages/server/src/config.ts`) pins the running
  server's "today". Unset in normal use. It exists because the fixtures cover a
  fixed span while the calendar moves; without it the dev app and the Playwright
  run open on a month the seed has no data for.
- **`formatCents` moved to `@finance/shared` as `formatEur`**, as this spec
  requires, and the 002/003 components now import it from there. The parsing
  half (`parseEurosToCents`) stayed in the web package — only the UI needs it.
- **Assets and their snapshots are fixture data.** They live in
  `fixtures/expected.json`, and `seed-data.ts` (extracted from `seed-test.ts`)
  loads them, so the net-worth expectations and the seeded values cannot drift.

### Follow-ups (not built)

- **The dashboard is not the landing view.** Import still is. Making the
  dashboard the default is a reasonable product call but is a behavior change to
  specs 001–003, so it is left to the owner.
- **The seeded category breakdown is effectively one slice.** `seed-test.ts`
  inserts its labeling rules *after* committing the import, so they never apply
  and ~320 of 349 rows stay Uncategorized. The breakdown card is therefore
  truthful but visually thin on seed data. Fixing it means changing 003's seed
  ordering, which is out of scope here.
- Drill-down from a chart into the underlying transaction list (already listed
  as deferred below).
- **`fixtures/generate.mjs` normalizes commitments in floating point.**
  `recurringCommitments()` uses `Math.round(Math.abs(cents) / intervalMonths)`
  while the server uses the pinned integer `roundHalfUpAwayFromZero`. Harmless
  today because every `SEEDED_TEMPLATES` amount divides evenly, so the two agree
  exactly — but a future template with a non-divisible amount would make the
  fixture and the server disagree by a cent, and the criterion 6 test would fail
  pointing at the server rather than at the generator. Port the integer helper
  into the generator before adding such a template.

## Deferred (needs a new approved spec)

- Live investment pricing / automatic asset valuation (snapshots are manual).
- Custom date ranges beyond month granularity; annual roll-ups.
- Drill-down from a chart into the underlying transaction list (nice-to-have; note
  as a follow-up, don't build).
- Configurable dashboard layout.

## Resolved decisions (owner, 2026-07-15)

- **004-A — Differentiate income sources.** ✅ Income is **category-driven** via
  `categories.is_income_source` (added in spec 001), not sign-based. This yields
  the three buckets the owner wanted: **Salary** (Income category), **Other income**
  (other income-source categories), and **Reimbursements** (positive amounts left
  in an expense category, which net that category down rather than counting as
  income). A `/dashboard/income` endpoint exposes the salary-vs-other split.
- **004-B — Net-worth months without a snapshot.** ✅ **Carry-forward.** _Context:_
  asset values (investments, loans) are entered manually each month, but a month may
  be skipped. Carry-forward uses the most recent entered value for that asset
  (`month ≤ M`) so the trend line stays continuous instead of dropping to zero on a
  missed entry. The value only changes when you enter a new snapshot.
- **004-C — Trend window.** ✅ Default **12 months**, with selectable **3 / 6 / 9 /
  12** on the net-worth and cash-flow cards.
- **004-D — Current (partial) month.** ✅ Show the current month as **"month to
  date"**.

## Resolved decisions (owner, 2026-07-18)

- **004-E — Months before an account's opening balance date.** ✅ **Clamp the trend,
  and contribute 0 before the opening date.** _Context:_ 004-B's carry-forward is
  forward-only; nothing was said about the other end, where the balance formula's
  window is empty and the naive read returns `opening_balance_cents` — a flat line
  extending back before the account was tracked. That output is wrong in the worst
  way: it looks right. Contributing 0 keeps the aggregate honest (net worth is the
  money we have records for), and clamping the window start to the earliest
  opening date keeps the chart from opening on a run of empty months. The rejected
  alternative — render the pre-opening months with the account excluded and no
  clamp — shows the same information with more chart real estate spent on nothing;
  the `partialAccounts` flag carries the "not every account was open yet" caveat
  either way.
- **004-F — Archiving an asset vs. carry-forward.** ✅ **Archiving is a form-visibility
  change only; snapshots keep carrying forward.** _Context:_ carry-forward as
  specified in 004-B never expires, so an archived paid-off loan would subtract
  from net worth forever, and the obvious "helpful" fix — excluding archived assets
  from the net-worth query — silently **rewrites history**, changing what net worth
  was in 2025 because of a checkbox ticked in 2026. History is immutable; the
  correct way to end an asset's contribution is to record that it ended, by
  entering a final snapshot (0 for a settled loan; 0 in the proceeds-landing month
  for a liquidated investment), then archiving. `PUT` therefore rejects archived
  assets — the final snapshot must come first, and the ordering is enforced rather
  than documented.

No open questions remain for this spec. The normalized monthly commitments tile
follows decision **003-E** = (a): a read-only dashboard indicator, budgets untouched.
The per-category divergence from spec 003 follows decision **003-M** and is stated
in Definitions above with criterion 7 as its test.
