# Spec 004 — Dashboard (overview)

Status: **draft, awaiting owner approval**
Depends on: 001 (schema), 002 (transactions), 003 (budget reconciliation).

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
  positive magnitude.
- **Account balance at date D** = `opening_balance_cents` +
  Σ `amount_cents` for that account with `payment_date ≤ D`.
- **Net worth at month M** (end of month) — see formula below.

```text
netWorth(M) =  Σ account_balance(account, monthEnd(M))   over all accounts (incl. the buffer / emergency fund)
             + Σ latest snapshot with month ≤ M           for kinds {investment, other}
             − Σ latest snapshot with month ≤ M           for kind loan
```

The emergency fund is the **buffer Account**, so its balance is already in the
account term — it is not a separate asset (decision 001-D). Snapshots are carried
forward: the latest one with `month ≤ M` (decision 004-B) — so a month with no new
snapshot reuses the last entered value instead of dropping to zero.

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

Asset management + snapshot entry:

- `GET /api/assets`, `POST /api/assets` `{ name, kind }`,
  `PATCH /api/assets/:id` (rename/archive).
- `GET /api/asset-snapshots?month=YYYY-MM` → current values for that month
  (with carry-forward indicator).
- `PUT /api/asset-snapshots` `{ month, values: [{ assetId, valueCents }] }` →
  upsert the month's snapshot per asset (unique on `(asset_id, month)`).

## UI sketch

A single dashboard route, responsive card grid (Recharts for charts):

- **Net worth trend** (line/area): total net worth, with a breakdown toggle
  (accounts / investments / −loans; the buffer/emergency fund is part of accounts)
  and a window selector **3 / 6 / 9 / 12 months** (default 12). Reads `/net-worth`.
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
- **Asset snapshot entry**: a small form/modal listing each asset with the current
  month's value pre-filled (carried forward if not yet entered); Save `PUT`s the
  month's snapshot. Loans are entered as positive balances and shown subtracted in
  net worth.

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
6. **UI ↔ API tie-out**: the numbers rendered on the dashboard (read from the
   Playwright DOM) equal the API responses for the same seed — asserted, not eyeballed.
7. Playwright screenshot of the dashboard with seeded data visible in every card.

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

No open questions remain for this spec.
