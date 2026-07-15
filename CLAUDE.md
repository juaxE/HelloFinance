# CLAUDE.md — Personal Finance Tracker

Local-first personal finance app for a single user (built by AI agents, reviewed by
the owner, a professional software engineer — communicate accordingly: no basics,
justify non-obvious decisions, push back when a spec seems wrong).

Tracks income, expenses, budgets with recurring expenses, and net worth
(accounts + investments + emergency fund − loans). Data is imported from bank CSV
exports and labeled via a learned rule engine with user confirmation.

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

## Tech stack (settled — do not re-litigate)

- TypeScript everywhere, single monorepo, npm workspaces
- Backend: Fastify, SQLite via better-sqlite3 + Drizzle ORM, Zod validation
- Frontend: Vite + React, Recharts for visualizations
- Shared types package between API and UI
- Tests: Vitest (unit/integration, in-memory or tempfile SQLite), Playwright (e2e)
- Runs with one command (`npm run dev`); production-ish mode via one command too


## Validation

An implementation is validated only when all of the following hold, in order:

1. `npm run typecheck && npm run lint` — clean.
2. `npm test` — all Vitest suites green. Integration tests use in-memory or
   tempfile SQLite; never touch `data/*.db`.
3. Seed a known dataset: `npm run seed:test` loads fixtures with known
   totals (fixture expectations live in `fixtures/expected.json`).
4. Exercise the real app: start `npm run dev`, then verify the changed
   behavior end-to-end via Playwright (`npm run e2e`, plus a targeted spec
   for the new feature if one doesn't exist — write it).
5. Evidence requirements:
   - For any change touching import, categorization, or computation:
     assert computed balances/reports against `fixtures/expected.json`
     and include the assertion output.
   - For any UI change: Playwright screenshot of the changed view with
     seeded data visible.
6. Numbers shown in the UI must reconcile with numbers computed by the API
   for the same seed data. A mismatch is a critical finding, not a rounding
   footnote.

### Not covered by automated validation (escalate instead)

- Anything requiring my real transaction data.
- Visual/aesthetic judgment beyond "renders without error".

## Repo layout

```
CLAUDE.md
specs/           # numbered feature specs; source of truth for behavior
fixtures/        # synthetic S-Pankki CSVs and seed data (never real data)
packages/
  shared/        # zod schemas + shared types
  server/        # fastify app, db schema, migrations, import pipeline
  web/           # vite + react app
```

## Workflow (spec-gated)

1. Every feature starts as a spec in `specs/NNN-name.md`: behavior, data model
   changes, API surface, acceptance criteria, explicitly deferred parts.
2. The owner reviews and approves the spec before implementation.
3. Implementation must include tests proving the acceptance criteria. A feature is
   not done until `npm run check` (typecheck + lint + tests) passes.
4. Keep diffs reviewable: small commits, no drive-by refactors, no speculative
   abstraction. Note follow-up ideas at the bottom of the relevant spec instead of
   implementing them.

## Domain model (summary — details live in specs)

- **Account**: multiple bank accounts supported from day one (main + buffer/
  emergency fund). Transactions belong to an account.
- **Transaction**: imported row; payment date is the primary date (booking date
  stored too), integer cents, counterparty, type, reference, message, archive ID,
  one category. Category assignment records its source: `rule` or `manual`.
- **Category**: flat list (~15 to start), user-editable, plus special built-ins:
  `Transfer` (excluded from all income/expense aggregates; used for moves between
  own accounts) and `Income`. Future (not MVP): split transactions via a
  transaction→lines table; keep this in mind, do not build it.
- **Labeling rules**: normalized-counterparty → category mappings, learned from user
  labeling decisions. Manual label always beats rule. Relabeling a transaction asks
  whether to update the rule or apply one-off. Normalization strips noise prefixes
  (`PAYPAL *`, `VFI*`, `MOB.PAY*`), store numbers, and casing.
- **Recurring expense template**: name, category, amount_cents, expected day-of-
  month, start date, optional end date. Editing a template affects only months
  materialized after the edit; past budget lines are historical record.
- **Budget (monthly)**: materialized from active templates when the month is
  created; lines are editable/deletable; ad-hoc one-off lines can be added.
  Reconciliation: named recurring lines match by counterparty rule; everything else
  reconciles at category level (budget line vs. sum of that category's transactions
  in the month).
- **Asset snapshot**: manual monthly values for investments, emergency fund, and
  loans (loans are negative in net worth). No live pricing, no amortization math.
- **Net worth** = latest account balances + asset snapshots − loan balances.

## S-Pankki CSV adapter

Adapter interface per bank; S-Pankki is the only implementation for now.
Format facts (verified against sample in `fixtures/`):

- Semicolon-delimited; header row in Finnish; encoding must be detected
  (UTF-8 vs ISO-8859-1), not assumed
- Columns: Kirjauspäivä (booking date), Maksupäivä (payment date), Summa (amount),
  Tapahtumalaji (type), Maksaja (payer), Saajan nimi (payee), Saajan tilinumero,
  Saajan BIC-tunnus, Viitenumero (reference), Viesti (message), Arkistointitunnus
  (unique archive ID → dedup key)
- Dates `DD.MM.YYYY`; amounts signed with decimal comma (`-83,22`, `+2826,41`)
- `'-'` (with leading apostrophe) means empty; messages are wrapped in a leading
  apostrophe + quotes; IBAN fields may contain stray internal/trailing spaces
- Counterparty for labeling: payee for outgoing, payer for incoming
- Type hints for auto-labeling: `OMA TILISIIRTO` → Transfer, `PALKKA` → Income

## Import & labeling flow (first-class app feature, not a separate script)

Upload CSV → parse & dedup → review screen listing transactions with proposed
labels → user confirms/corrects (bulk "apply to all similar" is required, one-by-one
prompting is not acceptable — the owner will bulk-import ~1 year of history) →
commit + persist learned rules.

## Explicitly deferred (do not build without a new approved spec)

Split transactions, live investment pricing, multi-currency, additional bank
adapters, automatic transfer pair-matching, desktop packaging, Windows support,
auth, income budgeting, hierarchical categories.
