import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client';
import { accounts, categories, recurringTemplates, transactions } from '../src/db/schema';
import { createTestDb } from './helpers';

let db: Db;
let accountId: number;
let categoryId: number;

beforeEach(() => {
  db = createTestDb();
  accountId = db.insert(accounts).values({ name: 'Main' }).returning().get().id;
  categoryId = db.select().from(categories).where(eq(categories.name, 'Groceries')).get()!.id;
});

function baseTxn(overrides: Partial<typeof transactions.$inferInsert> = {}) {
  return {
    accountId,
    paymentDate: '2026-01-15',
    bookingDate: '2026-01-15',
    amountCents: -1234,
    type: 'KORTTIOSTO',
    counterparty: 'K-MARKET',
    contentHash: 'hash-1',
    ...overrides,
  } satisfies typeof transactions.$inferInsert;
}

describe('archive_id idempotency (AC 001-2)', () => {
  it('rejects a second transaction with the same non-null archive_id', () => {
    db.insert(transactions).values(baseTxn({ archiveId: 'ARK-1', contentHash: 'h1' })).run();
    expect(() =>
      db
        .insert(transactions)
        .values(baseTxn({ archiveId: 'ARK-1', contentHash: 'h2', amountCents: -9999 }))
        .run(),
    ).toThrow(/UNIQUE/i);
  });

  it('allows multiple null archive_ids (fallback-dedup rows)', () => {
    db.insert(transactions).values(baseTxn({ archiveId: null, contentHash: 'h1' })).run();
    expect(() =>
      db.insert(transactions).values(baseTxn({ archiveId: null, contentHash: 'h2' })).run(),
    ).not.toThrow();
  });
});

describe('foreign keys enforced (AC 001-4)', () => {
  it('has PRAGMA foreign_keys ON', () => {
    const rows = db.$client.pragma('foreign_keys') as Array<{ foreign_keys: number }>;
    expect(rows[0]?.foreign_keys).toBe(1);
  });

  it('rejects deleting a category referenced by a transaction', () => {
    db.insert(transactions)
      .values(baseTxn({ categoryId, categorySource: 'manual', archiveId: 'ARK-2' }))
      .run();
    expect(() => db.delete(categories).where(eq(categories.id, categoryId)).run()).toThrow(
      /FOREIGN KEY/i,
    );
  });
});

describe('single system category (AC 001-5)', () => {
  it('rejects a second transfer or income via uq_categories_system_key', () => {
    expect(() =>
      db.insert(categories).values({ name: 'Transfer 2', systemKey: 'transfer' }).run(),
    ).toThrow(/UNIQUE/i);
    expect(() =>
      db.insert(categories).values({ name: 'Income 2', systemKey: 'income' }).run(),
    ).toThrow(/UNIQUE/i);
  });
});

describe('category_source invariant (AC 001-7)', () => {
  it('rejects a category_id without a source', () => {
    expect(() =>
      db.insert(transactions).values(baseTxn({ categoryId, categorySource: null })).run(),
    ).toThrow(/CHECK/i);
  });

  it('rejects a source without a category_id', () => {
    expect(() =>
      db.insert(transactions).values(baseTxn({ categoryId: null, categorySource: 'manual' })).run(),
    ).toThrow(/CHECK/i);
  });

  it('accepts a fully-null (uncategorized) and a fully-set row', () => {
    expect(() =>
      db.insert(transactions).values(baseTxn({ archiveId: 'A', contentHash: 'h1' })).run(),
    ).not.toThrow();
    expect(() =>
      db
        .insert(transactions)
        .values(
          baseTxn({ categoryId, categorySource: 'rule', archiveId: 'B', contentHash: 'h2' }),
        )
        .run(),
    ).not.toThrow();
  });
});

describe('recurring template checks (AC 001-8)', () => {
  function baseTemplate(overrides: Partial<typeof recurringTemplates.$inferInsert> = {}) {
    return {
      name: 'Gym',
      categoryId,
      amountCents: 4990,
      expectedDayOfMonth: 15,
      startMonth: '2025-07',
      ...overrides,
    } satisfies typeof recurringTemplates.$inferInsert;
  }

  it('rejects interval_months = 0', () => {
    expect(() =>
      db.insert(recurringTemplates).values(baseTemplate({ intervalMonths: 0 })).run(),
    ).toThrow(/CHECK/i);
  });

  it('rejects expected_day_of_month = 32', () => {
    expect(() =>
      db.insert(recurringTemplates).values(baseTemplate({ expectedDayOfMonth: 32 })).run(),
    ).toThrow(/CHECK/i);
  });

  it('defaults interval_months to 1 (monthly) when omitted', () => {
    const row = db.insert(recurringTemplates).values(baseTemplate()).returning().get();
    expect(row.intervalMonths).toBe(1);
  });
});
