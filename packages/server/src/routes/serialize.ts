import type { Account, Category, LabelingRule, Transaction } from '@finance/shared';
import type { accounts, categories, labelingRules, transactions } from '../db/schema';

type AccountRow = typeof accounts.$inferSelect;
type CategoryRow = typeof categories.$inferSelect;
type TransactionRow = typeof transactions.$inferSelect;
type LabelingRuleRow = typeof labelingRules.$inferSelect;

/** DB row -> API shape: timestamps become epoch-ms integers. */
export function serializeAccount(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    iban: row.iban,
    openingBalanceCents: row.openingBalanceCents,
    openingBalanceDate: row.openingBalanceDate,
    createdAt: row.createdAt.getTime(),
  };
}

export function serializeCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    name: row.name,
    systemKey: row.systemKey,
    isIncomeSource: row.isIncomeSource,
    color: row.color,
    sortOrder: row.sortOrder,
    archivedAt: row.archivedAt ? row.archivedAt.getTime() : null,
    createdAt: row.createdAt.getTime(),
  };
}

export function serializeTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    accountId: row.accountId,
    paymentDate: row.paymentDate,
    bookingDate: row.bookingDate,
    amountCents: row.amountCents,
    type: row.type,
    payer: row.payer,
    payee: row.payee,
    counterparty: row.counterparty,
    counterpartyIban: row.counterpartyIban,
    reference: row.reference,
    message: row.message,
    archiveId: row.archiveId,
    categoryId: row.categoryId,
    categorySource: row.categorySource,
    note: row.note,
    importId: row.importId,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

export function serializeLabelingRule(row: LabelingRuleRow): LabelingRule {
  return {
    id: row.id,
    normalizedCounterparty: row.normalizedCounterparty,
    categoryId: row.categoryId,
    exampleRaw: row.exampleRaw,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/** Normalize an IBAN for storage: strip all whitespace, uppercase. */
export function normalizeIban(iban: string): string {
  return iban.replace(/\s+/g, '').toUpperCase();
}

/** better-sqlite3 raises this code on any UNIQUE-index violation. */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}
