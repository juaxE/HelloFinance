/**
 * @finance/shared — Zod schemas and types shared between the API and the UI.
 *
 * Domain schemas are added per the approved specs under `specs/`. Spec 001
 * introduces the reference resources every later spec assumes: accounts and
 * categories. Spec 002 adds transactions, labeling rules, and the CSV import
 * review pipeline. Spec 003 adds recurring templates, budget months, and
 * reconciliation. Spec 004 adds the dashboard aggregates and `formatEur`, the
 * single euro formatter. Money is always integer cents; timestamps cross the
 * wire as epoch-ms integers; business dates as `YYYY-MM-DD` strings.
 */

export * from './common';
export * from './account';
export * from './category';
export * from './transaction';
export * from './labeling-rule';
export * from './import';
export * from './budget';
export * from './dashboard';
export * from './money';
