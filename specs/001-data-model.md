# Spec 001 — Data model (MVP schema)

Status: **approved & implemented (2026-07-16)**
Depends on: nothing. Depended on by: 002 (import), 003 (budgets), 004 (dashboard).

## Purpose

Define the full persistent schema for the MVP so that 002–004 build on a stable
foundation: accounts, transactions, categories, labeling rules, recurring
templates, monthly budgets + budget lines, and asset snapshots. This spec owns
the Drizzle tables, the idempotency constraints, the money/date/timestamp
conventions, and the seed of built-in categories. It deliberately does **not**
own import parsing (002), budget behavior (003), or aggregation (004) — only the
shapes those specs read and write.

## Conventions (apply to every table)

- **Money**: integer `_cents` columns, signed. Never floats (non-negotiable #3).
  Transaction amounts keep the sign from the bank (outgoing negative, incoming
  positive). Planned/snapshot magnitudes are stored positive; see per-table notes.
- **Business dates** (booking/payment/period): `text` in ISO `YYYY-MM-DD`. No time,
  no timezone — these are calendar dates from the bank.
- **Months**: `text` in `YYYY-MM`.
- **Timestamps** (`created_at`/`updated_at`): `integer` epoch-ms (`mode: 'timestamp_ms'`).
- **IDs**: integer autoincrement primary keys. Single-user local app; no need for
  UUIDs.
- **Enums**: SQLite has no enum type — use Drizzle `text(..., { enum: [...] })`
  plus a CHECK where it guards an invariant.
- **No `currency` column.** EUR only (non-negotiable #3; multi-currency deferred).
- **Foreign keys**: `PRAGMA foreign_keys = ON` is set on every connection
  (already wired in `packages/server/src/db/client.ts`).

## Tables (Drizzle — `packages/server/src/db/schema.ts`)

> These definitions replace the placeholder `export {}` once this spec is approved.
> All of it ships as one Drizzle migration; migrations are the only way to change
> the schema (non-negotiable #6).

```ts
import { sqliteTable, integer, text, uniqueIndex, index, check } from 'drizzle-orm/sqlite-core';
import { sql, relations } from 'drizzle-orm';

// --- Accounts --------------------------------------------------------------
// A bank account that owns transactions. Multiple from day one (main + buffer).
export const accounts = sqliteTable('accounts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  // Display label only — nothing in specs 003/004 branches on kind; net-worth math
  // counts every account equally (the buffer/emergency fund is NOT special-cased).
  // Left open-ended so a future savings/other account fits without a migration.
  kind: text('kind', { enum: ['main', 'buffer', 'savings', 'other'] })
    .notNull()
    .default('main'),
  iban: text('iban'), // normalized (no spaces); may be null for cash-like accounts
  // The bank CSV has no running-balance column, so a balance is derived:
  //   balance(D) = opening_balance_cents
  //              + Σ amount_cents WHERE opening_balance_date ≤ payment_date ≤ D
  // opening_balance_cents is the real balance at the START of opening_balance_date
  // (immediately before the first transaction counted). Only transactions on/after
  // that date count, so setting the opening balance from a recent statement and
  // then back-filling older history does NOT double count — rows dated before
  // opening_balance_date fall outside the window and are rejected at import
  // (spec 002). Null opening_balance_date ⇒ no lower bound, opening 0 (fresh
  // account). Spec 004 net-worth math inherits this exact boundary. Decision 001-A.
  openingBalanceCents: integer('opening_balance_cents').notNull().default(0),
  openingBalanceDate: text('opening_balance_date'), // YYYY-MM-DD, nullable
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});

// --- Categories ------------------------------------------------------------
// Flat, user-editable list plus system built-ins (Transfer, Income).
export const categories = sqliteTable(
  'categories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    // 'transfer' and 'income' are the only system keys. null => ordinary user
    // category. Transfer is excluded from every income/expense/breakdown
    // aggregate (non-negotiable domain rule).
    systemKey: text('system_key', { enum: ['transfer', 'income'] }),
    // Income-source categories count toward income; everything else (except
    // Transfer, which is excluded entirely) is expense. Drives the income vs
    // expense split and the income-source breakdown (spec 004, decision 004-A).
    // The Income built-in is seeded true; user income categories (e.g. a future
    // "Other income") set it true too.
    isIncomeSource: integer('is_income_source', { mode: 'boolean' }).notNull().default(false),
    color: text('color'), // optional hex for dashboard charts; UI concern
    sortOrder: integer('sort_order').notNull().default(0),
    // Soft-delete: archived categories keep historical transaction assignments
    // but disappear from pickers. Hard delete is blocked by FK from transactions.
    archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    // Case-insensitive name uniqueness (decision 001-I): 'Groceries'/'groceries'
    // collide, so a human-typed flat list can't accumulate case-only duplicates.
    nameUq: uniqueIndex('uq_categories_name').on(sql`${t.name} collate nocase`),
    systemKeyUq: uniqueIndex('uq_categories_system_key').on(t.systemKey), // at most one of each
  }),
);

// --- Transactions ----------------------------------------------------------
export const transactions = sqliteTable(
  'transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id),

    // payment_date (Maksupäivä) is the primary date used by all aggregates.
    paymentDate: text('payment_date').notNull(), // YYYY-MM-DD
    bookingDate: text('booking_date').notNull(), // Kirjauspäivä, kept for reference

    amountCents: integer('amount_cents').notNull(), // signed

    type: text('type').notNull(), // Tapahtumalaji, e.g. KORTTIOSTO, PALKKA, E-LASKU
    payer: text('payer'), // Maksaja
    payee: text('payee'), // Saajan nimi
    // Derived at import: payee when amount<0 (outgoing), payer when amount>0
    // (incoming). This is what labeling/normalization run on.
    counterparty: text('counterparty').notNull(),
    counterpartyIban: text('counterparty_iban'), // normalized, nullable
    counterpartyBic: text('counterparty_bic'), // normalized, nullable
    reference: text('reference'), // Viitenumero, nullable
    message: text('message'), // Viesti, unwrapped, nullable

    // Idempotency (non-negotiable #4). S-Pankki always provides archive_id.
    archiveId: text('archive_id'), // Arkistointitunnus; unique when present
    // Fallback dedup for future banks without a unique id: hash of
    // (account, payment_date, amount, counterparty, reference, message).
    // Computed for every row (cheap, future-proof); NOT uniquely constrained for
    // S-Pankki rows — see decision 001-B.
    contentHash: text('content_hash').notNull(),

    // Category + provenance of the assignment.
    // null category_id => Uncategorized (not yet reviewed) — a distinct state
    // from the reviewed catch-all "Other" category (decision 001-G / 002-C).
    categoryId: integer('category_id').references(() => categories.id),
    // How the category was assigned: 'manual' (user), 'rule' (learned
    // counterparty rule), 'type_hint' (deterministic from Tapahtumalaji:
    // OMA TILISIIRTO->Transfer, PALKKA->Income). null when uncategorized.
    // 'manual' always wins (decision 002-A).
    categorySource: text('category_source', { enum: ['manual', 'rule', 'type_hint'] }),

    // Free-text user annotation, distinct from the bank's `message`. Optional;
    // local-only like everything else. Editable any time (never touched by import).
    note: text('note'),

    importId: integer('import_id').references(() => imports.id), // provenance
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    // Bumped by the app on every mutation (relabel, note edit). Transactions are
    // mutable after import; every other mutable table already tracks this.
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    // Multiple NULL archive_ids are allowed (SQLite treats NULLs as distinct),
    // so this both enforces S-Pankki idempotency and permits future null rows.
    // Global (not per-account) on purpose: it also catches a CSV imported into the
    // wrong account as duplicates instead of silently double-importing (see 002).
    archiveIdUq: uniqueIndex('uq_transactions_archive_id').on(t.archiveId),
    accountDateIdx: index('idx_transactions_account_payment_date').on(t.accountId, t.paymentDate),
    categoryIdx: index('idx_transactions_category').on(t.categoryId),
    counterpartyIdx: index('idx_transactions_counterparty').on(t.counterparty),
    importIdIdx: index('idx_transactions_import_id').on(t.importId), // provenance lookups
    // Invariant: a row is either fully categorized (id + source) or fully
    // uncategorized (both null). Guards against a "categorized but sourceless" row
    // that would break the review/relabel filtering in spec 002.
    categorySourceCk: check(
      'ck_transactions_category_source',
      sql`(category_id is null) = (category_source is null)`,
    ),
  }),
);

// --- Labeling rules --------------------------------------------------------
// normalized-counterparty -> category, learned from user labeling decisions.
export const labelingRules = sqliteTable(
  'labeling_rules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    normalizedCounterparty: text('normalized_counterparty').notNull(),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id),
    // An example raw string for display ("PAYPAL *SPOTIFY*P41B7F3E9").
    exampleRaw: text('example_raw'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    // One category per normalized counterparty.
    normUq: uniqueIndex('uq_labeling_rules_normalized').on(t.normalizedCounterparty),
  }),
);

// --- Recurring templates ---------------------------------------------------
// Named recurring expense; materialized into budget lines per month (spec 003).
export const recurringTemplates = sqliteTable(
  'recurring_templates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id),
    // Magnitude billed EACH occurrence, stored positive (decision 001-C). NOT a
    // monthly-normalized figure: a 600 €/yr insurance is amount_cents=60000 with
    // interval_months=12, and materializes a single 600 € line in its due month —
    // not 50 €/month. See decision 001-H.
    amountCents: integer('amount_cents').notNull(),
    // Billing cadence in months: 1 = monthly, 3 = quarterly, 6 = semi-annual,
    // 12 = yearly (any interval ≥ 1 allowed). start_month is the anchor phase: the
    // template is "due" in month M iff monthsBetween(start_month, M) is a
    // non-negative multiple of interval_months and M is within [start, end]. The
    // due-month formula and materialization live in spec 003.
    intervalMonths: integer('interval_months').notNull().default(1),
    // 1..31 (CHECK below); clamped to short months at materialization (spec 003),
    // which is behavior, not schema.
    expectedDayOfMonth: integer('expected_day_of_month').notNull(),
    // Month granularity — templates apply per whole month, so there is no
    // day-level ambiguity about whether a mid-month start counts (was YYYY-MM-DD).
    // start_month is both the first eligible month and the cadence anchor;
    // end_month (nullable) is the inclusive last eligible month.
    startMonth: text('start_month').notNull(), // YYYY-MM
    endMonth: text('end_month'), // YYYY-MM, nullable; inclusive last month
    // How the materialized line reconciles against actual transactions: named
    // lines match by this normalized counterparty (spec 003). Null => the line
    // reconciles at category level only.
    matchNormalizedCounterparty: text('match_normalized_counterparty'),
    note: text('note'), // optional plan rationale; snapshotted onto budget lines
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    intervalCk: check('ck_recurring_interval_months', sql`interval_months >= 1`),
    dayCk: check('ck_recurring_expected_day', sql`expected_day_of_month between 1 and 31`),
  }),
);

// --- Budgets (a materialized month) ---------------------------------------
export const budgets = sqliteTable(
  'budgets',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    month: text('month').notNull(), // YYYY-MM
    note: text('note'), // optional month-level note (planning rationale for the month)
    materializedAt: integer('materialized_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({ monthUq: uniqueIndex('uq_budgets_month').on(t.month) }),
);

// --- Budget lines ----------------------------------------------------------
// Snapshot of a template at materialization time, OR an ad-hoc one-off line.
// Editing a template does NOT retroactively change already-materialized lines.
export const budgetLines = sqliteTable(
  'budget_lines',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    budgetId: integer('budget_id')
      .notNull()
      .references(() => budgets.id),
    // Provenance only; the line carries its own snapshot values below.
    templateId: integer('template_id').references(() => recurringTemplates.id),
    kind: text('kind', { enum: ['recurring', 'adhoc'] }).notNull(),
    name: text('name').notNull(),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id),
    amountCents: integer('amount_cents').notNull(), // planned magnitude, positive
    expectedDayOfMonth: integer('expected_day_of_month'), // nullable for ad-hoc
    matchNormalizedCounterparty: text('match_normalized_counterparty'), // named-line reconciliation
    note: text('note'), // optional; snapshotted from the template at materialization, editable per month
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    // Snapshot lines store the already-clamped day; ad-hoc lines may leave it null.
    dayCk: check(
      'ck_budget_lines_expected_day',
      sql`expected_day_of_month is null or expected_day_of_month between 1 and 31`,
    ),
  }),
);

// --- Assets + snapshots ----------------------------------------------------
// Manual monthly values for things NOT tracked as bank accounts.
// The emergency fund is a bank Account (kind 'buffer'), not an asset — it is
// "money on another account with no card", so its balance comes from
// transactions like any account (decision 001-D). Assets are only investments,
// loans, and any other non-bank holding.
export const assets = sqliteTable('assets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  // 'loan' contributes negatively to net worth; 'investment'/'other' positively.
  kind: text('kind', { enum: ['investment', 'loan', 'other'] }).notNull(),
  archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const assetSnapshots = sqliteTable(
  'asset_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    assetId: integer('asset_id')
      .notNull()
      .references(() => assets.id),
    month: text('month').notNull(), // YYYY-MM
    // Reported balance, stored POSITIVE even for loans. Net-worth math negates
    // loan-kind assets. See decision 001-E.
    valueCents: integer('value_cents').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({ assetMonthUq: uniqueIndex('uq_asset_snapshots_asset_month').on(t.assetId, t.month) }),
);

// --- Imports (batch provenance; pipeline detail in spec 002) --------------
export const imports = sqliteTable('imports', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  bank: text('bank', { enum: ['s-pankki'] }).notNull(),
  accountId: integer('account_id')
    .notNull()
    .references(() => accounts.id),
  filename: text('filename').notNull(),
  encodingDetected: text('encoding_detected', { enum: ['utf-8', 'iso-8859-1'] }).notNull(),
  rowCount: integer('row_count').notNull().default(0),
  insertedCount: integer('inserted_count').notNull().default(0),
  duplicateCount: integer('duplicate_count').notNull().default(0),
  status: text('status', { enum: ['pending_review', 'committed', 'discarded'] })
    .notNull()
    .default('pending_review'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});
```

Notes:

- `staged_transactions` (the pre-commit review buffer) is defined in **spec 002**,
  since it is a mechanism of the import pipeline, not part of the committed domain.
- Drizzle `relations()` are declared alongside for query ergonomics; omitted here
  for brevity.
- **Notes (free-text annotations)**: `transactions`, `recurring_templates`,
  `budget_lines`, and `budgets` each carry an optional `note`. Transaction notes
  are user-owned and never touched by import; a budget line snapshots its
  template's note at materialization and is then editable per month (details in
  specs 002 and 003). Notes are local-only text like all other data. Not added to
  reference tables (accounts, categories, assets) unless asked.

## Seed data (ships with the initial migration)

- Built-in categories: **Transfer** (`system_key='transfer'`) and **Income**
  (`system_key='income'`, `is_income_source=true`).
- Starter set of ordinary categories (approved; expected to grow as the project is
  used): Groceries, Restaurants & Cafés, Transport, Housing, Utilities, Health,
  Subscriptions, Shopping, Entertainment, Travel, Fees & Interest, Cash, **Other**.
  Anticipated additions the owner flagged: **Personal loans**. The list is
  user-editable, so new categories emerge without a migration.
- **Other** is the reviewed catch-all (a real category); **Uncategorized** is the
  not-yet-reviewed state, represented by `category_id = null` (no row). The two are
  distinct and shown differently in the UI (decision 001-G / 002-C).

## API surface

001 defines storage, not endpoints. The only endpoints it introduces directly are
the foundational reference resources every later spec assumes:

- `GET /api/accounts`, `POST /api/accounts`, `PATCH /api/accounts/:id`
  (name, kind, iban, opening balance + date).
- `GET /api/categories`, `POST /api/categories`, `PATCH /api/categories/:id`
  (rename, reorder, color, `is_income_source`, archive). **System categories**
  (Transfer, Income) are locked in **five** ways the PATCH/DELETE handlers enforce:
  they cannot be **deleted**, **renamed** (decision 001-I), **archived**, or have
  their `system_key` changed, and their `is_income_source` is fixed (Transfer stays
  `false`, Income stays `true`). Archiving Transfer would silently break the
  transfer-exclusion rule across every aggregate; renaming it would let it
  masquerade as an ordinary category while still being excluded — so both are
  rejected rather than "improved".

Transaction, import, budget, and dashboard endpoints live in their own specs.

## UI sketch

No dedicated screen. Accounts and categories are managed from a **Settings** area:
a list of accounts (name, kind, IBAN, opening balance + date) and an editable,
reorderable category list with color swatches and an archive action. Built-ins are
shown but locked.

> **Implementation status (2026-07-16):** the schema, migrations, category seed,
> and the accounts/categories reference API are implemented and validated (all
> acceptance criteria below pass; verified end-to-end over HTTP). The **Settings
> UI above is intentionally deferred** (owner decision) — it will be built
> alongside the import/dashboard work, where seeded data can validate it. The
> backend surface it needs is already in place.

## Acceptance criteria

1. `npm run db:generate -w @finance/server` produces one migration; `db:migrate`
   applies cleanly to an empty DB and re-applies as a no-op.
2. Inserting two transactions with the same non-null `archive_id` fails on
   `uq_transactions_archive_id`.
3. Money columns are integer; a review of the migration SQL shows no REAL columns.
4. `PRAGMA foreign_keys` is ON; deleting a category referenced by a transaction is
   rejected.
5. The seed inserts exactly one `transfer` and one `income` category; a second
   insert of either violates `uq_categories_system_key`.
6. All timestamps round-trip as `Date` via Drizzle; business dates round-trip as
   `YYYY-MM-DD` strings.
7. `ck_transactions_category_source` rejects a half-set row (category_id present
   with null category_source, and the reverse); a fully-null and a fully-set row
   both insert.
8. The recurring-template CHECKs reject `interval_months = 0` and
   `expected_day_of_month = 32`; `interval_months` defaults to 1 (monthly) when
   omitted.

## Deferred (needs a new approved spec)

- Split transactions (a `transaction_lines` child table). Schema is intentionally
  shaped so this can be added later without migrating existing rows.
- Automatic transfer pair-matching between accounts.
- Any per-transaction currency (multi-currency).

## Resolved decisions (owner, 2026-07-15)

- **001-A — Account opening balance (semantics pinned).** ✅ Manual
  `opening_balance_cents` + `opening_balance_date` per account, entered in Settings.
  `opening_balance_cents` is the real balance at the **start of**
  `opening_balance_date`, and the derived balance counts only transactions with
  `payment_date ≥ opening_balance_date`:
  `balance(D) = opening + Σ amount WHERE opening_balance_date ≤ payment_date ≤ D`.
  This closes a double-count (found in review): you can set the opening balance from
  a recent statement and still back-fill older history without inflating the
  balance — rows dated before `opening_balance_date` are outside the window and are
  **rejected at import** (spec 002) so nothing silently falls off the ledger. Null
  `opening_balance_date` ⇒ no lower bound, opening 0 (fresh account). Spec 004
  net-worth math inherits this boundary verbatim.
- **001-B — Fallback dedup hash.** ✅ No uniqueness constraint on `content_hash`
  for now (S-Pankki uses `archive_id`; a `content_hash` unique would wrongly
  reject two genuinely-identical small purchases the same day). `content_hash` is
  stored and only becomes the enforced key when a future adapter lacks a unique id.
- **001-C — Recurring/budget amount sign.** ✅ Stored as a **positive expected
  magnitude**; reconciliation compares magnitudes. (See summary note explaining
  the trade-off — easy to switch to signed later if preferred.)
- **001-D — Emergency fund.** ✅ It's a bank **Account** (kind `buffer`), balance
  from transactions — not an asset. The `emergency_fund` asset kind is removed;
  assets are only `investment | loan | other`.
- **001-E — Loan sign.** ✅ Loan snapshots stored as a **positive** balance,
  negated in net-worth math.
- **001-F — Starter categories.** ✅ List approved; expected to grow (Personal
  loans anticipated). User-editable; new categories need no migration.
- **001-G — Uncategorized.** ✅ `category_id = null` (no row) for the
  not-yet-reviewed state; **Other** remains a distinct reviewed catch-all category.
  UI shows the two differently.
- **001-H — Non-monthly billing cadence (owner request, 2026-07-16).** ✅ Recurring
  templates carry `interval_months` (1 monthly / 3 quarterly / 12 yearly / any ≥ 1)
  anchored on `start_month`; `amount_cents` is the per-occurrence charge, not a
  monthly average. A template materializes a budget line **only in its due months**
  (spec 003), so a yearly bill appears once, at full amount, in the month it is
  actually charged and reconciles against that real transaction — clean tracking
  without a fake monthly line. An amortized "monthly-equivalent commitments" figure
  is surfaced **read-only** on the dashboard (Σ `amount_cents / interval_months`;
  decision 003-E → spec 004), leaving budgets on real due-month charges — reporting,
  not this schema.
- **001-I — Category-name uniqueness + system-rename lock (owner, 2026-07-16, during
  implementation review).** ✅ Two category-integrity decisions surfaced by fresh-
  context review: (1) `uq_categories_name` is **case-insensitive** (`collate nocase`)
  so 'Groceries'/'groceries' can't both exist — the right behavior for a human-typed
  flat list and it backs the POST 409 dedup. (2) System categories **cannot be
  renamed** (the fourth lock becomes a fifth), closing the footgun where a renamed
  Transfer looks ordinary in pickers yet stays excluded from every aggregate. Recolor
  and reorder remain allowed for system categories. The `collate nocase` migration
  drops+recreates the index; it is safe here because all three migrations first-apply
  together to a fresh DB (nothing released), so the recreate never meets a
  pre-existing case-only duplicate. Were this ever applied to a DB that already
  contained case-colliding names, the `CREATE UNIQUE INDEX` would (correctly) abort
  until the duplicate is resolved.

No open questions remain. The reporting question this schema enabled (003-E,
amortized view of non-monthly bills) is resolved in specs 003/004 as a read-only
dashboard stat.
