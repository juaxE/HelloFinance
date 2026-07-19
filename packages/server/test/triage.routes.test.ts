import { eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TriageApplyResult, TriageQueue } from '@finance/shared';
import { buildApp } from '../src/app';
import type { Db } from '../src/db/client';
import { accounts, categories, labelingRules, transactions } from '../src/db/schema';
import { categoryBreakdown } from '../src/dashboard/aggregates';
import { createTestDb, seedFixtureApp } from './helpers';

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

let hashCounter = 0;
function insertUncategorized(counterparty: string, overrides: Partial<typeof transactions.$inferInsert> = {}) {
  return db
    .insert(transactions)
    .values({
      accountId,
      paymentDate: '2026-01-15',
      bookingDate: '2026-01-15',
      amountCents: -1000,
      type: 'KORTTIOSTO',
      counterparty,
      contentHash: `hash-${++hashCounter}`,
      ...overrides,
    })
    .returning()
    .get();
}

async function queue(): Promise<TriageQueue> {
  const res = await app.inject({ method: 'GET', url: '/api/transactions/uncategorized' });
  expect(res.statusCode).toBe(200);
  return res.json() as TriageQueue;
}

async function applyGroup(body: {
  normalizedCounterparty: string;
  categoryId: number;
  rememberRule: boolean;
}) {
  return app.inject({ method: 'POST', url: '/api/transactions/triage/group', payload: body });
}

describe('triage queue', () => {
  it('criterion 1: an uncategorized transaction appears in exactly one group, keyed on its normalized counterparty', async () => {
    insertUncategorized('K-Market Kamppi 4021');
    const categorized = insertUncategorized('Alepa Kamppi');
    db.update(transactions)
      .set({ categoryId: groceriesId, categorySource: 'manual' })
      .where(eq(transactions.id, categorized.id))
      .run();

    const { totalCount, groups } = await queue();
    expect(totalCount).toBe(1);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.normalizedCounterparty).toBe('K-MARKET');
    expect(groups[0]!.rows).toHaveLength(1);
  });

  it('criterion 2: counterparties differing only by store number or brand suffix share one group', async () => {
    insertUncategorized('Alepa Kamppi');
    insertUncategorized('ALEPA 0123');
    insertUncategorized('Alepa Töölöntori');

    const { groups } = await queue();
    expect(groups).toHaveLength(1);
    expect(groups[0]!.normalizedCounterparty).toBe('ALEPA');
    expect(groups[0]!.count).toBe(3);
    expect(groups[0]!.totalAmountCents).toBe(-3000);
  });

  it('groups are ordered by count descending, then by absolute total', async () => {
    insertUncategorized('Alepa Kamppi');
    insertUncategorized('Alepa Kamppi');
    insertUncategorized('Prisma Itäkeskus', { amountCents: -50000 });
    insertUncategorized('Lidl Kamppi', { amountCents: -100 });

    const { groups } = await queue();
    expect(groups.map((g) => g.normalizedCounterparty)).toEqual(['ALEPA', 'PRISMA', 'LIDL']);
  });

  it('criterion 9: the count endpoint reports zero once the backlog is drained', async () => {
    insertUncategorized('Alepa Kamppi');
    const before = await app.inject({ method: 'GET', url: '/api/transactions/uncategorized/count' });
    expect(before.json()).toEqual({ count: 1 });

    await applyGroup({ normalizedCounterparty: 'ALEPA', categoryId: groceriesId, rememberRule: false });

    const after = await app.inject({ method: 'GET', url: '/api/transactions/uncategorized/count' });
    expect(after.json()).toEqual({ count: 0 });
  });
});

describe('applying a group', () => {
  it('criterion 3: remembering a rule categorizes every matching row as `rule` and inserts one rule', async () => {
    insertUncategorized('Alepa Kamppi');
    insertUncategorized('ALEPA 0123');

    const res = await applyGroup({
      normalizedCounterparty: 'ALEPA',
      categoryId: groceriesId,
      rememberRule: true,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as TriageApplyResult;
    expect(body.appliedCount).toBe(2);
    expect(body.source).toBe('rule');
    expect(body.ruleCreated).toBe(true);

    const rows = db.select().from(transactions).all();
    expect(rows.every((r) => r.categoryId === groceriesId)).toBe(true);
    expect(rows.every((r) => r.categorySource === 'rule')).toBe(true);

    const rules = db.select().from(labelingRules).all();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.normalizedCounterparty).toBe('ALEPA');
    expect(rules[0]!.categoryId).toBe(groceriesId);
  });

  it('criterion 4: applying without remembering writes `manual` and inserts no rule', async () => {
    insertUncategorized('Alepa Kamppi');

    const res = await applyGroup({
      normalizedCounterparty: 'ALEPA',
      categoryId: groceriesId,
      rememberRule: false,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as TriageApplyResult).source).toBe('manual');

    expect(db.select().from(transactions).get()!.categorySource).toBe('manual');
    expect(db.select().from(labelingRules).all()).toHaveLength(0);
  });

  it('criterion 5: re-applying an existing rule writes `rule` and inserts nothing', async () => {
    db.insert(labelingRules)
      .values({ normalizedCounterparty: 'ALEPA', categoryId: groceriesId })
      .run();
    insertUncategorized('Alepa Kamppi');

    const res = await applyGroup({
      normalizedCounterparty: 'ALEPA',
      categoryId: groceriesId,
      rememberRule: false,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as TriageApplyResult;
    expect(body.source).toBe('rule');
    expect(body.ruleCreated).toBe(false);

    expect(db.select().from(transactions).get()!.categorySource).toBe('rule');
    expect(db.select().from(labelingRules).all()).toHaveLength(1);
  });

  it('criterion 6: a rule pointing elsewhere is a 409 that writes nothing', async () => {
    db.insert(labelingRules)
      .values({ normalizedCounterparty: 'ALEPA', categoryId: groceriesId })
      .run();
    insertUncategorized('Alepa Kamppi');

    const res = await applyGroup({
      normalizedCounterparty: 'ALEPA',
      categoryId: otherId,
      rememberRule: false,
    });
    expect(res.statusCode).toBe(409);

    expect(db.select().from(transactions).get()!.categoryId).toBeNull();
    expect(db.select().from(labelingRules).get()!.categoryId).toBe(groceriesId);
  });

  it('criterion 6: remembering over an existing rule is a 409 — triage never updates a rule', async () => {
    db.insert(labelingRules)
      .values({ normalizedCounterparty: 'ALEPA', categoryId: groceriesId })
      .run();
    insertUncategorized('Alepa Kamppi');

    const res = await applyGroup({
      normalizedCounterparty: 'ALEPA',
      categoryId: groceriesId,
      rememberRule: true,
    });
    expect(res.statusCode).toBe(409);
    expect(db.select().from(labelingRules).all()).toHaveLength(1);
    expect(db.select().from(transactions).get()!.categoryId).toBeNull();
  });

  it('leaves already-categorized rows sharing the counterparty alone', async () => {
    const settled = insertUncategorized('Alepa Kamppi');
    db.update(transactions)
      .set({ categoryId: otherId, categorySource: 'manual' })
      .where(eq(transactions.id, settled.id))
      .run();
    insertUncategorized('ALEPA 0123');

    await applyGroup({ normalizedCounterparty: 'ALEPA', categoryId: groceriesId, rememberRule: false });

    expect(db.select().from(transactions).where(eq(transactions.id, settled.id)).get()!.categoryId).toBe(
      otherId,
    );
  });
});

describe('per-transaction categorization', () => {
  it('criterion 7: a one_off leaves its group siblings uncategorized and creates no rule', async () => {
    const first = insertUncategorized('Alepa Kamppi');
    const second = insertUncategorized('ALEPA 0123');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${first.id}`,
      payload: { categoryId: groceriesId, scope: 'one_off' },
    });
    expect(res.statusCode).toBe(200);

    expect(db.select().from(transactions).where(eq(transactions.id, first.id)).get()!.categorySource).toBe(
      'manual',
    );
    expect(db.select().from(transactions).where(eq(transactions.id, second.id)).get()!.categoryId).toBeNull();
    expect(db.select().from(labelingRules).all()).toHaveLength(0);
  });
});

describe('undo', () => {
  async function applyAndUndo(rememberRule: boolean) {
    const applied = await applyGroup({
      normalizedCounterparty: 'ALEPA',
      categoryId: groceriesId,
      rememberRule,
    });
    const { undoToken } = applied.json() as TriageApplyResult;
    return app.inject({
      method: 'POST',
      url: '/api/transactions/triage/undo',
      payload: { undoToken },
    });
  }

  it('criterion 8: undo restores the rows and deletes a rule the same apply created', async () => {
    insertUncategorized('Alepa Kamppi');
    insertUncategorized('ALEPA 0123');

    const res = await applyAndUndo(true);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ restoredCount: 2, ruleDeleted: true });

    const rows = db.select().from(transactions).all();
    expect(rows.every((r) => r.categoryId === null && r.categorySource === null)).toBe(true);
    expect(db.select().from(labelingRules).all()).toHaveLength(0);
  });

  it('criterion 8: undo does not delete a rule that already existed', async () => {
    db.insert(labelingRules)
      .values({ normalizedCounterparty: 'ALEPA', categoryId: groceriesId })
      .run();
    insertUncategorized('Alepa Kamppi');

    const res = await applyAndUndo(false);
    expect(res.json()).toEqual({ restoredCount: 1, ruleDeleted: false });
    expect(db.select().from(labelingRules).all()).toHaveLength(1);
  });

  it('leaves a row edited since the apply alone', async () => {
    const first = insertUncategorized('Alepa Kamppi');
    insertUncategorized('ALEPA 0123');

    const applied = await applyGroup({
      normalizedCounterparty: 'ALEPA',
      categoryId: groceriesId,
      rememberRule: false,
    });
    const { undoToken } = applied.json() as TriageApplyResult;

    await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${first.id}`,
      payload: { categoryId: otherId, scope: 'one_off' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/transactions/triage/undo',
      payload: { undoToken },
    });
    expect(res.json()).toEqual({ restoredCount: 1, ruleDeleted: false });
    expect(db.select().from(transactions).where(eq(transactions.id, first.id)).get()!.categoryId).toBe(
      otherId,
    );
  });

  it('only the most recent apply is undoable', async () => {
    insertUncategorized('Alepa Kamppi');
    insertUncategorized('Prisma Itäkeskus');

    const first = await applyGroup({
      normalizedCounterparty: 'ALEPA',
      categoryId: groceriesId,
      rememberRule: false,
    });
    const staleToken = (first.json() as TriageApplyResult).undoToken;
    await applyGroup({
      normalizedCounterparty: 'PRISMA',
      categoryId: groceriesId,
      rememberRule: false,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/transactions/triage/undo',
      payload: { undoToken: staleToken },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('against the seeded fixtures', () => {
  it('criterion 10: draining a group moves its amount between buckets without changing the month total', async () => {
    const fixtureDb = createTestDb();
    seedFixtureApp(fixtureDb);
    const fixtureApp = buildApp(fixtureDb);
    await fixtureApp.ready();

    const month = '2026-01';
    const groceries = fixtureDb
      .select()
      .from(categories)
      .where(eq(categories.name, 'Groceries'))
      .get()!;

    const before = categoryBreakdown(fixtureDb, month);
    const beforeTotal = before.reduce((sum, e) => sum + e.amountCents, 0);
    const beforeUncategorized = before.find((e) => e.categoryId === null)!.amountCents;
    const beforeGroceries = before.find((e) => e.categoryId === groceries.id)?.amountCents ?? 0;

    // The ALEPA rows inside this month — the amount that should change hands.
    // `categoryBreakdown` reports expense MAGNITUDES (it negates at
    // aggregates.ts:187), so this is compared as a positive number.
    const alepaMagnitude = -fixtureDb
      .select()
      .from(transactions)
      .where(isNull(transactions.categoryId))
      .all()
      .filter((t) => t.counterparty.toUpperCase().startsWith('ALEPA') && t.paymentDate.startsWith(month))
      .reduce((sum, t) => sum + t.amountCents, 0);
    expect(alepaMagnitude).toBeGreaterThan(0);

    const res = await fixtureApp.inject({
      method: 'POST',
      url: '/api/transactions/triage/group',
      payload: { normalizedCounterparty: 'ALEPA', categoryId: groceries.id, rememberRule: true },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as TriageApplyResult).appliedCount).toBe(46);

    const after = categoryBreakdown(fixtureDb, month);
    const afterTotal = after.reduce((sum, e) => sum + e.amountCents, 0);
    const afterUncategorized = after.find((e) => e.categoryId === null)?.amountCents ?? 0;
    const afterGroceries = after.find((e) => e.categoryId === groceries.id)!.amountCents;

    expect(afterTotal).toBe(beforeTotal);
    expect(afterUncategorized).toBe(beforeUncategorized - alepaMagnitude);
    expect(afterGroceries).toBe(beforeGroceries + alepaMagnitude);

    await fixtureApp.close();
  });

  it('bunches the fixture backlog into repeat groups and singletons', async () => {
    const fixtureDb = createTestDb();
    seedFixtureApp(fixtureDb);
    const fixtureApp = buildApp(fixtureDb);
    await fixtureApp.ready();

    const res = await fixtureApp.inject({ method: 'GET', url: '/api/transactions/uncategorized' });
    const { totalCount, groups } = res.json() as TriageQueue;

    expect(totalCount).toBe(288);
    expect(groups[0]!.normalizedCounterparty).toBe('ALEPA');
    expect(groups[0]!.count).toBe(46);
    expect(groups.filter((g) => g.count === 1)).toHaveLength(6);
    // Every row is accounted for by exactly one group.
    expect(groups.reduce((sum, g) => sum + g.count, 0)).toBe(totalCount);

    await fixtureApp.close();
  });
});

describe('sending a transaction back to Uncategorized', () => {
  it('re-queues the row for triage and clears its source', async () => {
    const row = insertUncategorized('Alepa Kamppi');
    await applyGroup({ normalizedCounterparty: 'ALEPA', categoryId: groceriesId, rememberRule: false });
    expect(db.select().from(transactions).get()!.categoryId).toBe(groceriesId);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${row.id}`,
      payload: { categoryId: null, scope: 'one_off' },
    });
    expect(res.statusCode).toBe(200);

    const after = db.select().from(transactions).where(eq(transactions.id, row.id)).get()!;
    expect(after.categoryId).toBeNull();
    expect(after.categorySource).toBeNull();

    const { totalCount } = await queue();
    expect(totalCount).toBe(1);
  });

  it('rejects uncategorizing with update_rule — a rule must name a category', async () => {
    const row = insertUncategorized('Alepa Kamppi');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${row.id}`,
      payload: { categoryId: null, scope: 'update_rule' },
    });
    expect(res.statusCode).toBe(400);
    expect(db.select().from(labelingRules).all()).toHaveLength(0);
  });
});
