# CLAUDE.md — Personal Finance Tracker

## What this is

A local-first personal finance tracker for a single user: income, expenses,
budgets with recurring bills, and net worth. Data is imported from bank CSV
exports and labeled by a learned rule engine with user confirmation. Built by AI
agents and reviewed by the owner, a professional software engineer — communicate
accordingly: no basics, justify non-obvious decisions, push back when something
seems wrong.

## Non-negotiables (never violate, never "improve")

1. **Privacy is absolute.** All financial data stays on the local machine. No network
   calls that include transaction data, counterparties, amounts, balances, or any
   derivative of them. No telemetry, no error reporting services, no CDN-loaded
   scripts at runtime, no cloud LLM calls. Labeling is rule-based and local only.
2. **Server binds to 127.0.0.1 only.** No auth layer (localhost auth is theater —
   do not add a login page). Never bind 0.0.0.0.
3. **Money is integer cents (EUR only).** Never floats, never `number` arithmetic on
   euro values. Column names end in `_cents`. Formatting to `1 234,56 €` happens
   only at the UI edge.
4. **Imports are idempotent.** Re-importing an overlapping CSV must never create
   duplicates. Primary dedup key: S-Pankki `Arkistointitunnus` (unique archive ID),
   stored per transaction with a uniqueness constraint. Fallback for future banks
   without a unique ID: hash of (account, payment date, amount, counterparty,
   reference, message).
5. **Real data never enters the repo, tests, or agent context.** All fixtures are
   synthetic, in `fixtures/`. Development and tests run against fixtures only.
6. **Schema changes go through Drizzle migrations.** Never hand-edit the database.
   Migrations must be safe to run on a DB containing real data.
7. **English throughout** — code, UI, categories, docs. When translating Finnish
   banking/domain terms and the translation is ambiguous, ask the owner instead of
   guessing.

## Stack (settled — do not re-litigate)

TypeScript everywhere, single monorepo, npm workspaces. Backend: Fastify, SQLite
via better-sqlite3 + Drizzle ORM, Zod validation. Frontend: Vite + React, Recharts.
Shared types package between API and UI. Tests: Vitest (in-memory or tempfile
SQLite), Playwright (e2e). Runs with one command (`npm run dev`).

```
CLAUDE.md
fixtures/        # synthetic S-Pankki CSVs + expected.json (never real data)
packages/
  shared/        # zod schemas + shared types
  server/        # fastify app, db schema, migrations, import pipeline, budgets, dashboard
  web/           # vite + react app
```

## Domain overview

**Accounts.** Multiple from day one (main + buffer/emergency fund; the emergency
fund is a bank account, not an asset). The bank CSV has no running-balance column,
so balance is derived — this boundary is load-bearing, it is what stops back-filled
history from double-counting:

```
balance(D) = opening + Σ amount WHERE opening_balance_date ≤ payment_date ≤ D
```

`opening_balance_cents` is the real balance at the **start of**
`opening_balance_date`. Null `opening_balance_date` ⇒ no lower bound, opening 0.
Rows dated before the opening date are rejected at import, never silently dropped.

**Transactions & categories.** Payment date is the primary date (booking date
stored too), integer cents, counterparty, type, reference, message, archive ID, one
category, and a `category_source` of `manual | rule | type_hint` (`manual` always
wins). Categories are a flat user-editable list plus system built-ins `Transfer` and
`Income`. `category_id = null` is **Uncategorized** (not yet reviewed) — a distinct
state from the reviewed catch-all **Other**. Every aggregate splits categories three
ways:

- **Transfer** (`system_key='transfer'`) — excluded from every aggregate.
- **Income-source** (`is_income_source=true`) — counts as income.
- **Expense** (everything else, including **Uncategorized** = `category_id null`).

**Labeling rules.** `normalized_counterparty → category`, learned from user
decisions. Normalization uppercases, strips noise prefixes (`PAYPAL *`, `VFI*`,
`MOB.PAY*`), trailing processor codes, store numbers, and collapses known brands
(`ALEPA KAMPPI` → `ALEPA`) so locations share one rule.

**Bills vs envelopes** — two instruments, never conflated. A **bill** is a
`recurring_template` (fixed amount, cadence, due day, required counterparty) that
materializes a snapshot line into each due month; editing it affects **future**
months only, since materialized months are a historical record. A template is due
in month M iff `M ≥ start_month` and (`end_month` is null or `M ≤ end_month`), and
`monthsBetween(start_month, M) mod interval_months == 0`, where
`monthsBetween(a, b) = (b.year·12 + b.month) − (a.year·12 + a.month)`. The
per-occurrence amount is snapshotted **as-is, no division**. An **envelope** is a
per-month goal for a category, set by hand, never materialized from anything and
never carried forward.

| `kind`      | `match_normalized_counterparty` | `template_id` | `expected_day_of_month` | reconciles as         |
| ----------- | ------------------------------- | ------------- | ----------------------- | --------------------- |
| `recurring` | **required**                    | set           | set (clamped)           | always named          |
| `adhoc`     | **required**                    | null          | optional                | always named          |
| `envelope`  | **must be null**                | null          | null                    | always category-level |

**Reconciliation** has exactly two behaviors, determined by the **match key**, never
by `kind` (`kind` is provenance):

- **Named lines** (`match_normalized_counterparty` non-null — recurring or ad-hoc)
  **consume** their counterparty's transactions.
- **Envelopes** (no match key) take their category's **remainder**.

Matching is strictly within the month; an unmatched line reads *pending*, and a bill
that posts late surfaces as unbudgeted in the month it landed. Actuals are never
stored — always recomputed from transactions, so they survive re-imports and
relabels. The set being reconciled over is **M = the expense bucket**: it excludes
`Transfer` and every `is_income_source` category, and **includes** uncategorized
rows (which surface as their own "Needs review" bucket, with signed amounts).
Remaining rows in a category with **no envelope** are *unbudgeted*.

**Assets & net worth.** Manual monthly snapshots for investments and loans (no live
pricing, no amortization). Snapshots carry forward: the latest with `month ≤ M`, so
a skipped month reuses the last value instead of dropping to zero.

```
netWorth(M) =  Σ account_balance(account, monthEnd(M))   over all accounts (incl. the buffer / emergency fund)
             + Σ latest snapshot with month ≤ M           for kinds {investment, other}
             − Σ latest snapshot with month ≤ M           for kind loan
```

## S-Pankki CSV adapter

Adapter interface per bank; S-Pankki is the only implementation. Semicolon-delimited;
Finnish header row mapped **by name**, not position; encoding detected (UTF-8 vs
ISO-8859-1), never assumed. Columns: Kirjauspäivä (booking date), Maksupäivä (payment
date), Summa, Tapahtumalaji (type), Maksaja (payer), Saajan nimi (payee), Saajan
tilinumero, Viitenumero, Viesti, Arkistointitunnus (dedup key). Dates `DD.MM.YYYY`;
amounts signed with decimal comma (`-83,22`). `'-'` means empty; messages are wrapped
in a leading apostrophe + quotes; IBAN fields may contain stray spaces. Counterparty
for labeling is payee for outgoing, payer for incoming. Type hints: `OMA TILISIIRTO`
→ Transfer, `PALKKA` → Income.

Import flow: upload CSV → parse & dedup → review screen with proposed labels → user
confirms/corrects (**bulk "apply to all similar" is required**; one-by-one prompting
is not acceptable — the owner bulk-imports ~1 year of history) → commit + persist
learned rules.

## Tripwires (each one is a bug someone already tried to write)

- No `ON DELETE` on `budget_lines.template_id`; retire a template via `end_month`,
  never delete once materialized — past months are history.
- No uniqueness constraint on `content_hash` — two identical purchases the same day
  are legal; `archive_id` is the dedup key.
- `uq_transactions_archive_id` is **global, not per-account**, on purpose: it makes a
  CSV imported into the wrong account surface as duplicates instead of silently
  double-importing. This rests on an **unverified assumption** (owner-accepted
  2026-07-16) that S-Pankki `Arkistointitunnus` is unique across *all* of the owner's
  accounts, not just within one — unprovable here, since no real export may enter
  tests or agent context. If a genuine cross-account collision ever shows up in a real
  import, that is the signal to revisit `(account_id, archive_id)` — which would cost
  the wrong-account detection, so it is a trade, not a free fix. Do not "harden" this
  pre-emptively.
- The partial month is marked with a **hatch, never a fade**. Opacity cannot do this
  job: holding a faded bar at the 3:1 non-text contrast floor needs alpha 0.92 on the
  dark card and 1.00 on the light one, i.e. no fade at all. The hatch keeps the band
  solid and stripes it with a lighter/darker shade of its own colour, so the signal
  rides on neither hue nor luminance and survives greyscale and every CVD type.
- Chart fills are checked numerically, not by eye: every fill AND its hatch stripe must
  clear 3:1 against its own card, and no two bands in the spending stack may fall under
  ΔE 10 in deuteranopia simulation. Both defects shipped once — dark blue/purple
  converged at ΔE 7.6, and the light remainder grey sat at 2.82:1.
- Flow aggregates (cash flow, income, spending, budget) mark the current month
  `partial` and the dashboard excludes it from every window total — a flow accumulates
  over a period, so the month in progress is an *incomplete* period, not a small one.
  Net worth carries no such flag on purpose: a balance is a **stock**, complete at any
  instant. `NetWorthPoint.partialAccounts` is a different thing entirely (an account
  was not open yet) — do not conflate them.
- Dashboard window figures are **sums over complete months, never averages**. An
  average divides money, and division is confined to the commitments estimate with
  pinned rounding. If a figure seems to want an average, it wants a sum with a clearer
  label.
- The spending trend charts the top N categories ranked over the window's **complete**
  months only — ranking on a month in progress reshuffles the legend as the month
  fills. Uncategorized is never ranked and never folded into the collapsed remainder:
  it is the needs-review signal, not a small category.
- Triage bulk-apply writes `category_source='rule'`, never `'manual'`, whenever a
  labeling rule maps that key to the chosen category — the rows are rule-derived and
  must follow a later correction to it. `manual` is the tempting shortcut and would
  permanently exempt a whole counterparty's history from ever being corrected.
- Triage only ever INSERTs a labeling rule, never UPDATEs one: both routes to an
  update (`rememberRule` over an existing rule, or picking a different category) are
  409s. Rewriting a rule also retroactively relabels rule-sourced rows outside the
  triage view, and that blast radius belongs on the Rules screen where it is visible.
- The relabel sweep in `routes/transactions.ts` filters `category_source='rule'` and
  therefore *cannot* see uncategorized rows — `ck_transactions_category_source` forces
  their source null. Do not "simplify" triage by routing it through that endpoint.
- Playwright runs `workers: 1`: every spec shares one seeded `data/app.db` and several
  mutate it. Parallel specs interleave with the ones asserting the DOM against a
  freshly-fetched API figure, which is a race, not a flake to retry away.
- A running `npm run dev` server **hijacks the e2e suite**: `reuseExistingServer`
  adopts whatever answers on :3001 without applying the config's `FINANCE_NOW`, and
  that process keeps an open handle to the `data/app.db` that `seed:test` unlinked —
  so the suite runs unpinned against a stale database and fails far from the cause.
  The `setup` project asserts the server's month before anything else runs; never
  delete that gate, and stop the dev server before running e2e.
- Archived assets stay in net-worth queries — excluding them rewrites history.
  Retire an asset by entering a closing `0` snapshot, *then* archiving.
- `Transfer` and `Income` cannot be deleted, renamed, archived, or have
  `is_income_source` flipped — Transfer exclusion breaks everywhere otherwise.
- Never divide money outside the commitments stat (half-up, away from zero, per
  template); integer cents everywhere else, no floats ever.
- **M** (reconciliation set) = the expense bucket: excludes Transfer and
  income-source, **includes** uncategorized — both sides of every tie-out, or neither.
- Named-line attribution: the budgets month view reports under the **line's**
  category, the dashboard under the **transaction's**. Per-category divergence after
  a relabel is specified behavior, not a bug; the totals must still agree.
- Unbudgeted is keyed on the absence of an **envelope**, not of any line — a category
  with only a named line would otherwise drop its other spend out of the partition.
- Match keys: required on templates and ad-hoc lines, forbidden on envelopes, unique
  across non-ended templates and per month — no insert path may bypass that check.
- Envelopes are never auto-created (not from templates, prefill, or previous months)
  — zero envelopes **is** the "not budgeted yet" signal.
- Templates and lines may not target `Transfer` or an income-source category — they
  could never reconcile and would sit permanently pending.
- Editing `opening_balance_date` forward past committed transactions is rejected — it
  silently drops rows from the balance window.
- The extend-history assist is offered only when the file bridges the gap
  (`max(payment_date) ≥ old opening date`) — a partial file corrupts the opening balance.
- Seeded labeling rules must be inserted **before** `analyzeImport` (proposals are
  resolved at analyze time and frozen into staging), in **both** seed paths —
  `seed-test.ts` and `test/helpers.ts`. A rule seeded after the import still shows on
  the Rules screen while having labeled nothing.
- No seeded labeling rule may target an **income-source** category: `generate.mjs`
  computes the M-definition from type hints as a proxy for the category rule, and that
  proxy holds only while type hints are the sole source of category assignment.
- No-auth is valid ONLY behind 127.0.0.1. Any public deployment (e.g. the planned
  fly.io demo) must be demo-mode — non-persistent DB, synthetic seed only, real
  imports disabled — or grow auth first.
- Every confirm-then-act UI flow needs a test for the **decline** path — the
  archive-on-cancel bug shipped because only the accept path was tested.
- `FINANCE_NOW` gates budget materialization and the past-month write lock, not just
  display — it must fail loudly on bad values and must never be set outside tests.
  **Real mode refuses to start with it set**, so "outside tests" is structural.
- Real data never enters the repo, fixtures, tests, or agent context. The mechanism
  is `FINANCE_MODE` (`real` → `data/app.db`, `dev` → `data/dev.db`), which has **no
  default** — unset or invalid refuses to start, since guessing is how real data ends
  up under a dev workflow. The `_synthetic_seed` marker is checked in **both**
  directions: real mode refuses a marked DB, dev mode refuses an unmarked one, and
  dev stamps the marker on any fresh DB it creates. There is deliberately no path
  override (no `DATABASE_URL`) — an override walks straight past both guards. The
  residual hole is a real CSV imported into a dev instance, which nothing can detect
  from file contents; the permanent dev banner in the app shell is the accepted
  mitigation, so it must stay visible on every view and stay non-dismissible.
- `seed:test` seeds the dev path unconditionally and never reads `FINANCE_MODE` —
  what it writes is synthetic by construction, and there is no mode under which it
  should target the real DB. `assertSeedableDatabase` stays as defense in depth.
- drizzle-kit is pinned to the dev DB. The real DB receives migrations only at
  server startup (`index.ts` → `openDatabaseForMode` → `runMigrations`).

## Workflow

A new feature starts as a short proposal file: behavior, data model changes, API
surface, acceptance criteria, explicitly deferred parts. It exists **only** for the
owner's review round. On merge its durable residue is criterion-named tests plus any
new tripwire lines, and the proposal file is deleted — the tests are the spec.

- Name tests after the criterion they prove (`criterion 7: …`), so a criterion can be
  traced to its proof.
- **Behavioral silences during implementation are stop-and-ask**, never
  resolved-in-notes. A silence you resolve quietly becomes a rule nobody agreed to.
- Every merged change that rejected a tempting alternative adds a tripwire line above.
- Keep diffs reviewable: small commits, no drive-by refactors, no speculative
  abstraction.
- Commit + green `npm run check` is the exit state of every session.

### Validation

An implementation is validated only when all of the following hold, in order:

1. `npm run typecheck && npm run lint` — clean.
2. `npm test` — all Vitest suites green. Integration tests use in-memory or tempfile
   SQLite; never touch `data/*.db`.
3. `npm run seed:test` loads fixtures with known totals (`fixtures/expected.json`).
4. Exercise the real app: `npm run dev`, then verify the changed behavior end-to-end
   via Playwright (`npm run e2e`, plus a targeted spec for the new feature — write one
   if it doesn't exist). Note that `npm run check` does **not** run e2e.
5. For any change touching import, categorization, or computation: assert computed
   balances/reports against `fixtures/expected.json` and include the output. For any
   UI change: a Playwright screenshot of the changed view with seeded data visible.
6. Numbers shown in the UI must reconcile with numbers computed by the API for the
   same seed data. A mismatch is a critical finding, not a rounding footnote.
7. Passing tests are not evidence a feature works. Say "verified end-to-end" only
   after exercising the running app, and always report what you did **not** test.

**Not covered by automated validation — escalate instead:** anything requiring real
transaction data; visual/aesthetic judgment beyond "renders without error".

## Explicitly deferred (do not build without an approved proposal)

Split transactions, transaction-level reimbursement linking, sinking funds, budget
rollover, income budgeting, live investment pricing, multi-currency, additional bank
adapters, automatic transfer pair-matching, hierarchical categories, desktop
packaging, Windows support, auth.

Deferred with triage: bulk actions across several groups at once; undo beyond the
last apply, or persisted across reloads; editing `BRAND_KEYS` from the UI when
grouping is wrong. The seeded fixtures already demonstrate that last gap —
`stripTrailingProcessorToken` only strips a trailing `*`-segment containing a digit,
so `PAYPAL *SPOTIFY*P1DXYSB` normalizes to `SPOTIFY` while `PAYPAL *SPOTIFY*PAYSCU`
does not, and Spotify shows up as one group of 10 plus two singletons. Loosening the
digit rule risks eating real counterparty words, so it needs its own proposal.

**Open decision (owner-deferred 2026-07-19):** whether post-commit triage replaces
the pre-commit review screen. Both ship and coexist; the call gets made after living
with triage. Until then `ReviewScreen`/`GroupCard` and the staged-group API stay, and
the same labeling decision is reachable from two places with different
`category_source` semantics — that duplication is known and accepted, not an
oversight to tidy away.
