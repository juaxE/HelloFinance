import type { Account, Category } from '@finance/shared';
import type { accounts, categories } from '../db/schema';

type AccountRow = typeof accounts.$inferSelect;
type CategoryRow = typeof categories.$inferSelect;

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
