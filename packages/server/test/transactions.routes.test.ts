import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { Db } from '../src/db/client';
import { accounts, categories, labelingRules, transactions } from '../src/db/schema';
import { createTestDb } from './helpers';

let db: Db;
let app: FastifyInstance;
let accountId: number;
let groceriesId: number;
let otherId: number;

beforeEach(async () => {
  db = createTestDb();
  app = buildApp(db);
  await app.ready();
  accountId = db.insert(accounts).values({ name: 'Main' }).returning().get().id;
  groceriesId = db.select().from(categories).where(eq(categories.name, 'Groceries')).get()!.id;
  otherId = db.select().from(categories).where(eq(categories.name, 'Other')).get()!.id;
});

afterEach(async () => {
  await app.close();
});

function insertTransaction(overrides: Partial<typeof transactions.$inferInsert> = {}) {
  return db
    .insert(transactions)
    .values({
      accountId,
      paymentDate: '2026-01-15',
      bookingDate: '2026-01-15',
      amountCents: -1234,
      type: 'KORTTIOSTO',
      counterparty: 'K-Market Kamppi',
      contentHash: 'hash-1',
      ...overrides,
    })
    .returning()
    .get();
}

describe('GET /api/transactions', () => {
  it('lists transactions, optionally filtered by account', async () => {
    insertTransaction({ archiveId: 'A1', contentHash: 'h1' });
    const otherAccountId = db.insert(accounts).values({ name: 'Buffer' }).returning().get().id;
    insertTransaction({ accountId: otherAccountId, archiveId: 'A2', contentHash: 'h2' });

    const all = await app.inject({ method: 'GET', url: '/api/transactions' });
    expect(all.json()).toHaveLength(2);

    const filtered = await app.inject({
      method: 'GET',
      url: `/api/transactions?accountId=${accountId}`,
    });
    expect(filtered.json()).toHaveLength(1);
  });
});

describe('PATCH /api/transactions/:id (relabel/annotate)', () => {
  it('one_off sets category as manual without touching rules', async () => {
    const txn = insertTransaction({ archiveId: 'A1', contentHash: 'h1' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${txn.id}`,
      payload: { categoryId: groceriesId, scope: 'one_off' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ categoryId: groceriesId, categorySource: 'manual' });
    expect(db.select().from(labelingRules).all()).toHaveLength(0);
  });

  it('update_rule sets category and upserts the labeling rule for the normalized counterparty', async () => {
    const txn = insertTransaction({
      archiveId: 'A1',
      contentHash: 'h1',
      counterparty: 'K-Market Kamppi',
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${txn.id}`,
      payload: { categoryId: groceriesId, scope: 'update_rule' },
    });
    expect(res.statusCode).toBe(200);
    const rule = db
      .select()
      .from(labelingRules)
      .where(eq(labelingRules.normalizedCounterparty, 'K-MARKET'))
      .get();
    expect(rule?.categoryId).toBe(groceriesId);
  });

  it('re-patching with update_rule updates (not duplicates) the existing rule', async () => {
    const txn = insertTransaction({
      archiveId: 'A1',
      contentHash: 'h1',
      counterparty: 'K-Market Kamppi',
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${txn.id}`,
      payload: { categoryId: groceriesId, scope: 'update_rule' },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${txn.id}`,
      payload: { categoryId: otherId, scope: 'update_rule' },
    });
    const rules = db
      .select()
      .from(labelingRules)
      .where(eq(labelingRules.normalizedCounterparty, 'K-MARKET'))
      .all();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.categoryId).toBe(otherId);
  });

  it('a note-only edit needs no scope and never touches rules', async () => {
    const txn = insertTransaction({ archiveId: 'A1', contentHash: 'h1' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${txn.id}`,
      payload: { note: 'lunch with a friend' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().note).toBe('lunch with a friend');
    expect(res.json().categoryId).toBeNull();
    expect(db.select().from(labelingRules).all()).toHaveLength(0);
  });

  it('rejects categoryId without scope', async () => {
    const txn = insertTransaction({ archiveId: 'A1', contentHash: 'h1' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${txn.id}`,
      payload: { categoryId: groceriesId },
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s for a missing transaction', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/transactions/9999',
      payload: { note: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });
});
