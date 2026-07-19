/**
 * Drizzle schema for the SQLite database — the full MVP data model.
 *
 * Conventions (every table):
 *   - Money: integer `_cents` columns, signed; never floats (non-negotiable #3).
 *   - Business dates (booking/payment/period): text ISO `YYYY-MM-DD`, no time/tz.
 *   - Months: text `YYYY-MM`.
 *   - Timestamps (`created_at`/`updated_at`): integer epoch-ms (`timestamp_ms`).
 *   - IDs: integer autoincrement PKs (single-user local app).
 *   - No `currency` column — EUR only (non-negotiable #3).
 *   - `PRAGMA foreign_keys = ON` on every connection (see db/client.ts).
 *
 * Schema changes go through Drizzle migrations only (non-negotiable #6) — never
 * hand-edit the database. `staged_transactions` (the import review buffer, spec
 * 002) lives here too since it is a real table, just a pre-commit one.
 */

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
    // Case-insensitive: 'Groceries' and 'groceries' collide (decision 001-I).
    // A human-typed flat list should not accumulate case-only duplicates; this
    // also backs the POST 409 dedup path.
    nameUq: uniqueIndex('uq_categories_name').on(sql`${t.name} collate nocase`),
    systemKeyUq: uniqueIndex('uq_categories_system_key').on(t.systemKey), // at most one of each
  }),
);

// --- Imports (batch provenance; pipeline detail in spec 002) --------------
// Declared before `transactions` so its FK thunk resolves against a real table.
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
    // Retained source-only data; its sole (deferred) consumer is transfer
    // pair-matching. Never read by import/labeling/dedup (decision 002-F).
    counterpartyIban: text('counterparty_iban'), // normalized, nullable
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

// --- Staged transactions (pre-commit import review buffer, spec 002) ------
// Parsed rows live here from analyze until commit/discard; a committed or
// discarded import's staged rows are deleted (still 100% local, no privacy
// concern in keeping them in the same DB).
export const stagedTransactions = sqliteTable(
  'staged_transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    importId: integer('import_id')
      .notNull()
      .references(() => imports.id),
    paymentDate: text('payment_date').notNull(),
    bookingDate: text('booking_date').notNull(),
    amountCents: integer('amount_cents').notNull(),
    type: text('type').notNull(),
    payer: text('payer'),
    payee: text('payee'),
    counterparty: text('counterparty').notNull(),
    normalizedCounterparty: text('normalized_counterparty').notNull(),
    counterpartyIban: text('counterparty_iban'),
    reference: text('reference'),
    message: text('message'),
    archiveId: text('archive_id'),
    contentHash: text('content_hash').notNull(),
    // dedup + review state
    dupState: text('dup_state', {
      enum: ['new', 'duplicate_existing', 'duplicate_in_batch'],
    }).notNull(),
    // When dup_state='duplicate_existing', the account the existing row belongs
    // to — lets the review UI explain a CSV imported into the wrong account.
    duplicateAccountId: integer('duplicate_account_id').references(() => accounts.id),
    // payment_date < the target account's opening_balance_date: outside the
    // balance window (decision 001-A), so NOT committed by default.
    beforeOpening: integer('before_opening', { mode: 'boolean' }).notNull().default(false),
    proposedCategoryId: integer('proposed_category_id').references(() => categories.id),
    proposedSource: text('proposed_source', { enum: ['manual', 'rule', 'type_hint'] }),
    // user decisions during review:
    chosenCategoryId: integer('chosen_category_id').references(() => categories.id),
    rememberRule: integer('remember_rule', { mode: 'boolean' }).notNull().default(false),
    note: text('note'), // optional per-row note, copied to transactions on commit
  },
  (t) => ({
    importIdIdx: index('idx_staged_transactions_import_id').on(t.importId),
    normalizedIdx: index('idx_staged_transactions_normalized').on(
      t.importId,
      t.normalizedCounterparty,
    ),
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
  () => ({
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
    // Provenance, NOT reconciliation behavior (decision 003-G): behavior follows
    // the match key. 'envelope' is a per-month category goal (decision 003-I) and
    // is never materialized from anything. `kind` is unconstrained `text` in
    // migration 0000, so adding the value is a TypeScript change with no SQL
    // migration.
    kind: text('kind', { enum: ['recurring', 'adhoc', 'envelope'] }).notNull(),
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
  () => ({
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
  (t) => ({
    assetMonthUq: uniqueIndex('uq_asset_snapshots_asset_month').on(t.assetId, t.month),
    // Loans are stored positive and SUBTRACTED by the net-worth formula, so a
    // negative value would flip an asset's sign and raise net worth. Enforced
    // here as well as in `zAssetSnapshotsPut` so no write path — seeds and
    // fixtures included — can reach the invariant from behind the API.
    valueNonNegative: check('ck_asset_snapshots_value_nonneg', sql`${t.valueCents} >= 0`),
  }),
);

// --- Relations (query ergonomics; no columns/constraints of their own) -----

export const accountsRelations = relations(accounts, ({ many }) => ({
  transactions: many(transactions),
  imports: many(imports),
}));

export const categoriesRelations = relations(categories, ({ many }) => ({
  transactions: many(transactions),
  labelingRules: many(labelingRules),
  recurringTemplates: many(recurringTemplates),
  budgetLines: many(budgetLines),
}));

export const importsRelations = relations(imports, ({ one, many }) => ({
  account: one(accounts, { fields: [imports.accountId], references: [accounts.id] }),
  transactions: many(transactions),
  stagedTransactions: many(stagedTransactions),
}));

export const stagedTransactionsRelations = relations(stagedTransactions, ({ one }) => ({
  import: one(imports, { fields: [stagedTransactions.importId], references: [imports.id] }),
  duplicateAccount: one(accounts, {
    fields: [stagedTransactions.duplicateAccountId],
    references: [accounts.id],
  }),
  proposedCategory: one(categories, {
    fields: [stagedTransactions.proposedCategoryId],
    references: [categories.id],
  }),
  chosenCategory: one(categories, {
    fields: [stagedTransactions.chosenCategoryId],
    references: [categories.id],
  }),
}));

export const transactionsRelations = relations(transactions, ({ one }) => ({
  account: one(accounts, { fields: [transactions.accountId], references: [accounts.id] }),
  category: one(categories, { fields: [transactions.categoryId], references: [categories.id] }),
  import: one(imports, { fields: [transactions.importId], references: [imports.id] }),
}));

export const labelingRulesRelations = relations(labelingRules, ({ one }) => ({
  category: one(categories, { fields: [labelingRules.categoryId], references: [categories.id] }),
}));

export const recurringTemplatesRelations = relations(recurringTemplates, ({ one, many }) => ({
  category: one(categories, {
    fields: [recurringTemplates.categoryId],
    references: [categories.id],
  }),
  budgetLines: many(budgetLines),
}));

export const budgetsRelations = relations(budgets, ({ many }) => ({
  lines: many(budgetLines),
}));

export const budgetLinesRelations = relations(budgetLines, ({ one }) => ({
  budget: one(budgets, { fields: [budgetLines.budgetId], references: [budgets.id] }),
  template: one(recurringTemplates, {
    fields: [budgetLines.templateId],
    references: [recurringTemplates.id],
  }),
  category: one(categories, { fields: [budgetLines.categoryId], references: [categories.id] }),
}));

export const assetsRelations = relations(assets, ({ many }) => ({
  snapshots: many(assetSnapshots),
}));

export const assetSnapshotsRelations = relations(assetSnapshots, ({ one }) => ({
  asset: one(assets, { fields: [assetSnapshots.assetId], references: [assets.id] }),
}));
