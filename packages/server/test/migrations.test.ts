import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { accounts, categories } from '../src/db/schema';
import { createTestDb } from './helpers';

const ALL_TABLES = [
  'accounts',
  'categories',
  'imports',
  'transactions',
  'staged_transactions',
  'labeling_rules',
  'recurring_templates',
  'budgets',
  'budget_lines',
  'assets',
  'asset_snapshots',
];

describe('migrations (AC 001-1)', () => {
  it('applies to an empty DB and re-applies as a no-op', () => {
    const db = createDb(':memory:');
    runMigrations(db);

    const namesAfterFirst = tableNames(db);
    for (const t of ALL_TABLES) expect(namesAfterFirst).toContain(t);
    const seedCount = db.select().from(categories).all().length;

    // Second run must not throw and must not re-seed.
    expect(() => runMigrations(db)).not.toThrow();
    expect(db.select().from(categories).all().length).toBe(seedCount);
  });
});

describe('money columns are integer (AC 001-3)', () => {
  it('has no REAL columns anywhere in the schema', () => {
    const db = createTestDb();
    const sqlite = db.$client;
    const realColumns: string[] = [];
    for (const table of ALL_TABLES) {
      const cols = sqlite.pragma(`table_info(${table})`) as Array<{ name: string; type: string }>;
      for (const c of cols) {
        if (c.type.toUpperCase().includes('REAL')) realColumns.push(`${table}.${c.name}`);
      }
    }
    expect(realColumns).toEqual([]);
  });
});

describe('category seed (AC 001-5)', () => {
  it('seeds exactly one transfer and one income system category', () => {
    const db = createTestDb();
    const all = db.select().from(categories).all();
    expect(all.filter((c) => c.systemKey === 'transfer')).toHaveLength(1);
    expect(all.filter((c) => c.systemKey === 'income')).toHaveLength(1);
    // Income is the seeded income source; Transfer is not.
    const income = all.find((c) => c.systemKey === 'income')!;
    const transfer = all.find((c) => c.systemKey === 'transfer')!;
    expect(income.isIncomeSource).toBe(true);
    expect(transfer.isIncomeSource).toBe(false);
    // 13 starter + 2 system = 15; "Other" is a real reviewed category.
    expect(all).toHaveLength(15);
    expect(all.map((c) => c.name)).toContain('Other');
  });
});

describe('timestamp / date round-trips (AC 001-6)', () => {
  it('round-trips timestamps as Date and business dates as YYYY-MM-DD', () => {
    const db = createTestDb();
    const inserted = db
      .insert(accounts)
      .values({ name: 'Main', openingBalanceCents: 1000, openingBalanceDate: '2026-01-31' })
      .returning()
      .get();

    const read = db.select().from(accounts).where(eq(accounts.id, inserted.id)).get()!;
    expect(read.createdAt).toBeInstanceOf(Date);
    expect(read.openingBalanceDate).toBe('2026-01-31');
    expect(typeof read.openingBalanceDate).toBe('string');
  });
});

function tableNames(db: ReturnType<typeof createDb>): string[] {
  const rows = db.$client
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}
