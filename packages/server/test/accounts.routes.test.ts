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
