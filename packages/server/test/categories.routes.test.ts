import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { createTestDb } from './helpers';

let app: FastifyInstance;

beforeEach(async () => {
  app = buildApp(createTestDb());
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

type Category = {
  id: number;
  name: string;
  systemKey: 'transfer' | 'income' | null;
  isIncomeSource: boolean;
  sortOrder: number;
  archivedAt: number | null;
};

async function listCategories(): Promise<Category[]> {
  return (await app.inject({ method: 'GET', url: '/api/categories' })).json();
}

async function findByName(name: string): Promise<Category> {
  const c = (await listCategories()).find((x) => x.name === name);
  if (!c) throw new Error(`category ${name} not found`);
  return c;
}

describe('categories API (spec 001)', () => {
  it('lists the 15 seeded categories ordered by sortOrder', async () => {
    const cats = await listCategories();
    expect(cats).toHaveLength(15);
    const orders = cats.map((c) => c.sortOrder);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it('creates an ordinary category and ignores any client-supplied system_key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/categories',
      payload: { name: 'Pets', systemKey: 'transfer', color: '#a1b2c3' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'Pets', systemKey: null, color: '#a1b2c3' });
  });

  it('rejects a duplicate name with 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/categories',
      payload: { name: 'Groceries' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects a case-only duplicate name with 409 (decision 001-I)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/categories',
      payload: { name: 'groceries' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('archives and un-archives an ordinary category', async () => {
    const groceries = await findByName('Groceries');
    const archived = await app.inject({
      method: 'PATCH',
      url: `/api/categories/${groceries.id}`,
      payload: { archived: true },
    });
    expect(archived.statusCode).toBe(200);
    expect(typeof archived.json().archivedAt).toBe('number');

    const restored = await app.inject({
      method: 'PATCH',
      url: `/api/categories/${groceries.id}`,
      payload: { archived: false },
    });
    expect(restored.json().archivedAt).toBeNull();
  });

  it('locks system categories (rename/archive/is_income_source) but allows recolor', async () => {
    const transfer = await findByName('Transfer');
    const income = await findByName('Income');

    // Lock 0: cannot rename to a different name (decision 001-I)...
    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/categories/${transfer.id}`,
      payload: { name: 'Own transfers' },
    });
    expect(renamed.statusCode).toBe(409);

    // ...but a same-name patch is a permitted no-op (falls through the lock).
    const sameName = await app.inject({
      method: 'PATCH',
      url: `/api/categories/${transfer.id}`,
      payload: { name: transfer.name, sortOrder: 5 },
    });
    expect(sameName.statusCode).toBe(200);
    expect(sameName.json().name).toBe(transfer.name);

    // Lock 1: cannot archive.
    const archiveTransfer = await app.inject({
      method: 'PATCH',
      url: `/api/categories/${transfer.id}`,
      payload: { archived: true },
    });
    expect(archiveTransfer.statusCode).toBe(409);

    // Lock 2: cannot flip is_income_source (Transfer stays false, Income stays true).
    const flipTransfer = await app.inject({
      method: 'PATCH',
      url: `/api/categories/${transfer.id}`,
      payload: { isIncomeSource: true },
    });
    expect(flipTransfer.statusCode).toBe(409);

    const flipIncome = await app.inject({
      method: 'PATCH',
      url: `/api/categories/${income.id}`,
      payload: { isIncomeSource: false },
    });
    expect(flipIncome.statusCode).toBe(409);

    // Recolor is allowed; a client-supplied system_key rides along but is not a
    // patchable field, so it is ignored and the key stays 'income'. A no-op
    // is_income_source (same value) passes the lock.
    const recolor = await app.inject({
      method: 'PATCH',
      url: `/api/categories/${income.id}`,
      payload: { isIncomeSource: true, color: '#123456', systemKey: 'transfer' },
    });
    expect(recolor.statusCode).toBe(200);
    expect(recolor.json().color).toBe('#123456');
    expect(recolor.json().systemKey).toBe('income');
  });

  it('404s for a missing category', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/categories/9999',
      payload: { name: 'Nope' },
    });
    expect(res.statusCode).toBe(404);
  });
});
