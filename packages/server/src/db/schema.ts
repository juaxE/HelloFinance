/**
 * Drizzle schema for the SQLite database.
 *
 * Intentionally empty during scaffolding — there are no domain tables yet.
 * The full MVP schema (accounts, transactions, categories, labeling rules,
 * recurring templates, budgets + budget lines, asset snapshots) is defined by
 * specs/001-data-model.md and added here once that spec is approved.
 *
 * All monetary columns are integer cents and named with a `_cents` suffix
 * (non-negotiable #3). Schema changes go through Drizzle migrations only
 * (non-negotiable #6) — never hand-edit the database.
 */

export {};
