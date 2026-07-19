/**
 * @finance/shared — Zod schemas and types shared between the API and the UI.
 *
 * Covers the reference resources (accounts, categories), transactions, labeling
 * rules and the CSV import review pipeline, recurring templates, budget months
 * and reconciliation, and the dashboard aggregates plus `formatEur`, the single
 * euro formatter. Money is always integer cents; timestamps cross the wire as
 * epoch-ms integers; business dates as `YYYY-MM-DD` strings.
 */

export * from './common';
export * from './account';
export * from './category';
export * from './transaction';
export * from './labeling-rule';
export * from './import';
export * from './budget';
export * from './asset';
export * from './dashboard';
export * from './money';
