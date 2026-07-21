import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { buildApp } from '../src/app';
import type { Db } from '../src/db/client';
import { accounts, stagedTransactions, transactions } from '../src/db/schema';
import { analyzeImport, commitImport } from '../src/import/pipeline';
import { createTestDb, loadFixture } from './helpers';

let app: FastifyInstance;
let db: Db;

beforeEach(async () => {
  db = createTestDb();
  app = buildApp(db);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('accounts API (spec 001)', () => {
  it('starts empty and creates an account', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/accounts' })).json()).toEqual([]);

    const res = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'Main', kind: 'main' },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json();
    expect(created).toMatchObject({
      name: 'Main',
      kind: 'main',
      openingBalanceCents: 0,
      openingBalanceDate: null,
    });
    expect(typeof created.createdAt).toBe('number');

    const list = (await app.inject({ method: 'GET', url: '/api/accounts' })).json();
    expect(list).toHaveLength(1);
  });

  it('normalizes IBAN (strips spaces, uppercases)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'Buffer', kind: 'buffer', iban: 'fi21 1234 5600 0007 85' },
    });
    expect(res.json().iban).toBe('FI2112345600000785');
  });

  it('rejects a non-zero opening balance without an anchor date (decision 001-A)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'Main', openingBalanceCents: 5000 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts opening balance with a date and persists both', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'Main', openingBalanceCents: 5000, openingBalanceDate: '2026-01-01' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      openingBalanceCents: 5000,
      openingBalanceDate: '2026-01-01',
    });
  });

  it('patches a field and 404s for a missing account', async () => {
    const id = (
      await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Main' } })
    ).json().id;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${id}`,
      payload: { name: 'Everyday' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().name).toBe('Everyday');

    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/accounts/9999',
      payload: { name: 'Nope' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('rejects a patch that would leave a non-zero balance without a date', async () => {
    const id = (
      await app.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'Main', openingBalanceCents: 5000, openingBalanceDate: '2026-01-01' },
      })
    ).json().id;

    // Clearing the date while a non-zero balance remains is inconsistent.
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${id}`,
      payload: { openingBalanceDate: null },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /api/accounts/:id — opening balance date forward-edit guard (006)', () => {
  async function createAccount(payload: Record<string, unknown>): Promise<number> {
    const res = await app.inject({ method: 'POST', url: '/api/accounts', payload });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  function insertTransaction(accountId: number, paymentDate: string, archiveId: string) {
    db.insert(transactions)
      .values({
        accountId,
        paymentDate,
        bookingDate: paymentDate,
        amountCents: -1234,
        type: 'KORTTIOSTO',
        counterparty: 'K-Market Kamppi',
        archiveId,
        contentHash: `hash-${archiveId}`,
      })
      .run();
  }

  function patchDate(id: number, payload: Record<string, unknown>) {
    return app.inject({ method: 'PATCH', url: `/api/accounts/${id}`, payload });
  }

  function storedAccount(id: number) {
    return db.select().from(accounts).where(eq(accounts.id, id)).get();
  }

  function stageMainFixture(accountId: number): { importId: number } {
    return analyzeImport(db, { accountId, filename: 'main.csv', bytes: loadFixture('main') });
  }

  /** Only `new` rows carry a meaningful `before_opening`; duplicates are never re-analyzed. */
  function stagedNewRows(importId: number) {
    return db
      .select()
      .from(stagedTransactions)
      .where(and(eq(stagedTransactions.importId, importId), eq(stagedTransactions.dupState, 'new')))
      .all();
  }

  it('criterion 1: moving the date forward past committed rows is a 409 naming the earliest row and the dropped count', async () => {
    const id = await createAccount({
      name: 'Main',
      openingBalanceCents: 5000,
      openingBalanceDate: '2025-06-01',
    });
    insertTransaction(id, '2025-07-01', 'A1');
    insertTransaction(id, '2025-07-15', 'A2');

    const res = await patchDate(id, { openingBalanceDate: '2025-08-01' });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.message).toContain('2025-07-01');
    expect(body).toMatchObject({ earliestPaymentDate: '2025-07-01', droppedCount: 2 });

    // The account row is untouched.
    expect(storedAccount(id)).toMatchObject({
      openingBalanceDate: '2025-06-01',
      openingBalanceCents: 5000,
    });
  });

  it('criterion 2: moving the date to exactly the earliest committed payment date is allowed', async () => {
    const id = await createAccount({
      name: 'Main',
      openingBalanceCents: 5000,
      openingBalanceDate: '2025-06-01',
    });
    insertTransaction(id, '2025-07-01', 'A1');

    const res = await patchDate(id, { openingBalanceDate: '2025-07-01' });
    expect(res.statusCode).toBe(200);
    expect(res.json().openingBalanceDate).toBe('2025-07-01');
  });

  it('criterion 3: setting a date for the first time is guarded the same way', async () => {
    const id = await createAccount({ name: 'Main' });
    insertTransaction(id, '2025-07-01', 'A1');
    expect(storedAccount(id)?.openingBalanceDate).toBeNull();

    const late = await patchDate(id, {
      openingBalanceCents: 5000,
      openingBalanceDate: '2025-08-01',
    });
    expect(late.statusCode).toBe(409);
    expect(storedAccount(id)).toMatchObject({ openingBalanceDate: null, openingBalanceCents: 0 });

    const early = await patchDate(id, {
      openingBalanceCents: 5000,
      openingBalanceDate: '2025-06-01',
    });
    expect(early.statusCode).toBe(200);
    expect(early.json()).toMatchObject({
      openingBalanceDate: '2025-06-01',
      openingBalanceCents: 5000,
    });
  });

  it('criterion 4: an account with no transactions accepts any date', async () => {
    const id = await createAccount({ name: 'Buffer', kind: 'buffer' });

    const res = await patchDate(id, { openingBalanceCents: 100, openingBalanceDate: '2099-12-31' });
    expect(res.statusCode).toBe(200);
    expect(res.json().openingBalanceDate).toBe('2099-12-31');
  });

  it('criterion 4b: another account’s older rows do not block the date', async () => {
    const id = await createAccount({ name: 'Main' });
    const otherId = await createAccount({ name: 'Buffer', kind: 'buffer' });
    insertTransaction(otherId, '2025-07-01', 'A1');

    const res = await patchDate(id, { openingBalanceCents: 100, openingBalanceDate: '2026-01-01' });
    expect(res.statusCode).toBe(200);
    expect(res.json().openingBalanceDate).toBe('2026-01-01');
  });

  it('criterion 5: moving the date backward or clearing it widens the window and is allowed', async () => {
    const id = await createAccount({
      name: 'Main',
      openingBalanceCents: 5000,
      openingBalanceDate: '2025-06-01',
    });
    insertTransaction(id, '2025-07-01', 'A1');

    const backward = await patchDate(id, { openingBalanceDate: '2025-05-01' });
    expect(backward.statusCode).toBe(200);
    expect(backward.json().openingBalanceDate).toBe('2025-05-01');

    const res = await patchDate(id, { openingBalanceCents: 0, openingBalanceDate: null });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ openingBalanceDate: null, openingBalanceCents: 0 });
  });

  it('criterion 6: a patch that leaves the date alone is never blocked by it', async () => {
    const id = await createAccount({ name: 'Main' });
    insertTransaction(id, '2025-07-01', 'A1');
    // Reach the state the guard rejects without going through the guard: the
    // date is what committed history says it cannot be.
    db.update(accounts)
      .set({ openingBalanceDate: '2025-08-01', openingBalanceCents: 5000 })
      .where(eq(accounts.id, id))
      .run();

    const res = await patchDate(id, { name: 'Everyday' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Everyday', openingBalanceDate: '2025-08-01' });
  });

  it('criterion 7: moving the date re-analyzes staged rows of imports still in review', async () => {
    const id = await createAccount({
      name: 'Main',
      openingBalanceCents: 0,
      openingBalanceDate: '2025-07-01',
    });
    const { importId } = stageMainFixture(id);
    expect(stagedNewRows(importId).some((r) => r.beforeOpening)).toBe(false);

    // No committed rows yet, so the forward move is allowed — but the staged
    // rows' frozen before_opening flags were computed against 2025-07-01.
    const res = await patchDate(id, { openingBalanceCents: 0, openingBalanceDate: '2026-01-01' });
    expect(res.statusCode).toBe(200);

    const staged = stagedNewRows(importId);
    const nowExcluded = staged.filter((r) => r.beforeOpening);
    expect(nowExcluded.length).toBeGreaterThan(0);
    expect(nowExcluded.every((r) => r.paymentDate < '2026-01-01')).toBe(true);
    expect(staged.filter((r) => !r.beforeOpening).every((r) => r.paymentDate >= '2026-01-01')).toBe(
      true,
    );

    // …and the commit honours the new boundary rather than the analyze-time one.
    commitImport(db, importId, { allowUncategorized: true });
    const committed = db.select().from(transactions).where(eq(transactions.accountId, id)).all();
    expect(committed.length).toBeGreaterThan(0);
    expect(committed.every((r) => r.paymentDate >= '2026-01-01')).toBe(true);
  });

  it('criterion 7b: moving the date backward brings excluded staged rows back in-window', async () => {
    const id = await createAccount({
      name: 'Main',
      openingBalanceCents: 0,
      openingBalanceDate: '2026-01-01',
    });
    const { importId } = stageMainFixture(id);
    // The fixture starts 2025-07, so analyze froze the pre-2026 rows as excluded.
    expect(stagedNewRows(importId).filter((r) => r.beforeOpening).length).toBeGreaterThan(0);

    const res = await patchDate(id, { openingBalanceCents: 0, openingBalanceDate: null });
    expect(res.statusCode).toBe(200);

    expect(stagedNewRows(importId).some((r) => r.beforeOpening)).toBe(false);
    // Rows a stale flag would have silently dropped now commit.
    commitImport(db, importId, { allowUncategorized: true });
    const committed = db.select().from(transactions).where(eq(transactions.accountId, id)).all();
    expect(committed.some((r) => r.paymentDate < '2026-01-01')).toBe(true);
  });

  it('criterion 7c: re-analysis is scoped to this account’s imports that are still in review', async () => {
    const id = await createAccount({
      name: 'Main',
      openingBalanceCents: 0,
      openingBalanceDate: '2025-07-01',
    });
    // The other account anchors later than the fixture starts, so analyze froze
    // its pre-2026-03 rows as excluded — and at a different date than the one
    // Main moves to, so re-analysis leaking across accounts changes the count.
    const otherId = await createAccount({
      name: 'Buffer',
      kind: 'buffer',
      openingBalanceCents: 0,
      openingBalanceDate: '2026-03-01',
    });
    const otherImport = stageMainFixture(otherId).importId;
    const otherExcludedBefore = stagedNewRows(otherImport).filter((r) => r.beforeOpening).length;
    expect(otherExcludedBefore).toBeGreaterThan(0);

    const ownImport = stageMainFixture(id).importId;
    expect(stagedNewRows(ownImport).some((r) => r.beforeOpening)).toBe(false);

    // A forward move this account's own committed history does not forbid.
    const res = await patchDate(id, { openingBalanceCents: 0, openingBalanceDate: '2026-01-01' });
    expect(res.statusCode).toBe(200);

    // Own pending import re-analyzed…
    expect(stagedNewRows(ownImport).filter((r) => r.beforeOpening).length).toBeGreaterThan(0);
    // …the other account's untouched, flags exactly as analyze wrote them.
    expect(stagedNewRows(otherImport).filter((r) => r.beforeOpening)).toHaveLength(
      otherExcludedBefore,
    );
  });

  it('criterion 7d: a 409 leaves staged flags untouched', async () => {
    const id = await createAccount({
      name: 'Main',
      openingBalanceCents: 0,
      openingBalanceDate: '2025-07-01',
    });
    insertTransaction(id, '2025-07-01', 'A1');
    const pending = stageMainFixture(id).importId;
    expect(stagedNewRows(pending).some((r) => r.beforeOpening)).toBe(false);

    const res = await patchDate(id, { openingBalanceCents: 0, openingBalanceDate: '2026-01-01' });
    expect(res.statusCode).toBe(409);
    expect(stagedNewRows(pending).some((r) => r.beforeOpening)).toBe(false);
  });
});
