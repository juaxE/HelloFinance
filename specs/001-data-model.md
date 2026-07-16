# Spec 001 — Data model (MVP schema)

Status: **draft, awaiting owner approval**
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
  kind: text('kind', { enum: ['main', 'buffer'] })
    .notNull()
    .default('main'),
  iban: text('iban'), // normalized (no spaces); may be null for cash-like accounts
  // The bank CSV has no running-balance column, so current balance is
  // opening_balance_cents + sum(transactions.amount_cents). The opening balance
  // is the account balance immediately BEFORE opening_balance_date, entered
  // manually. See decision 001-A.
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
    nameUq: uniqueIndex('uq_categories_name').on(t.name),
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
  },
  (t) => ({
    // Multiple NULL archive_ids are allowed (SQLite treats NULLs as distinct),
    // so this both enforces S-Pankki idempotency and permits future null rows.
    archiveIdUq: uniqueIndex('uq_transactions_archive_id').on(t.archiveId),
    accountDateIdx: index('idx_transactions_account_payment_date').on(t.accountId, t.paymentDate),
    categoryIdx: index('idx_transactions_category').on(t.categoryId),
    counterpartyIdx: index('idx_transactions_counterparty').on(t.counterparty),
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
export const recurringTemplates = sqliteTable('recurring_templates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  categoryId: integer('category_id')
    .notNull()
    .references(() => categories.id),
  // Expected magnitude of the expense, stored positive. See decision 001-C.
  amountCents: integer('amount_cents').notNull(),
  expectedDayOfMonth: integer('expected_day_of_month').notNull(), // 1..31, clamped
  startDate: text('start_date').notNull(), // YYYY-MM-DD (first month it applies)
  endDate: text('end_date'), // nullable; inclusive last month it applies
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
});

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
export const budgetLines = sqliteTable('budget_lines', {
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
});

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
  encodingDetected: text('encoding_detected').notNull(), // 'utf-8' | 'iso-8859-1'
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
  (rename, reorder, color, `is_income_source`, archive). System categories cannot
  be deleted or have their `system_key` changed; the Income built-in stays
  `is_income_source=true`.

Transaction, import, budget, and dashboard endpoints live in their own specs.

## UI sketch

No dedicated screen. Accounts and categories are managed from a **Settings** area:
a list of accounts (name, kind, IBAN, opening balance + date) and an editable,
reorderable category list with color swatches and an archive action. Built-ins are
shown but locked.

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

## Deferred (needs a new approved spec)

- Split transactions (a `transaction_lines` child table). Schema is intentionally
  shaped so this can be added later without migrating existing rows.
- Automatic transfer pair-matching between accounts.
- Any per-transaction currency (multi-currency).

## Resolved decisions (owner, 2026-07-15)

- **001-A — Account opening balance.** ✅ Manual `opening_balance_cents` +
  `opening_balance_date` per account ("balance immediately before the first
  imported transaction"), entered in Settings.
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

No open questions remain for this spec.
