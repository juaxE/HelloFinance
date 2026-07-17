import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createTestDb } from './helpers';
import expected from '../../../fixtures/expected.json';

const FIXTURES_ROOT = resolve(__dirname, '../../../fixtures');
const loadFixture = (relPath: string) => readFileSync(resolve(FIXTURES_ROOT, relPath));

// Node's fetch types `Response.json()` as `Promise<unknown>`; these are
// integration tests against loosely-typed JSON, not the contract itself
// (which the shared zod schemas cover elsewhere), so a permissive JSON type
// is the pragmatic choice here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseJson = any;
async function json(res: Response): Promise<LooseJson> {
  return res.json();
}

// The upload endpoint is real multipart, which fastify's `inject()` cannot
// build directly — use a real loopback socket + native FormData/fetch instead.
let app: FastifyInstance;
let base: string;

beforeEach(async () => {
  app = buildApp(createTestDb());
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await app.close();
});

async function createAccount(openingBalanceDate = '2025-07-01'): Promise<number> {
  const res = await fetch(`${base}/api/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Main', openingBalanceDate }),
  });
  return (await json(res)).id;
}

async function uploadMainFixture(accountId: number) {
  const bytes = loadFixture(expected.files.main.path);
  const form = new FormData();
  form.append('accountId', String(accountId));
  form.append('file', new Blob([bytes]), 'main.csv');
  const res = await fetch(`${base}/api/imports`, { method: 'POST', body: form });
  return { res, body: await json(res) };
}

describe('POST /api/imports (upload + analyze)', () => {
  it('parses a multipart upload and returns counts + groups (AC 002-12 data)', async () => {
    const accountId = await createAccount();
    const { res, body } = await uploadMainFixture(accountId);
    expect(res.status).toBe(201);
    expect(body.counts).toEqual({
      total: expected.files.main.rowCount,
      new: expected.files.main.rowCount,
      duplicates: 0,
    });
    expect(body.groups.length).toBeGreaterThan(0);
  });

  it('400s when accountId is missing or invalid', async () => {
    const bytes = loadFixture(expected.files.main.path);
    const form = new FormData();
    form.append('file', new Blob([bytes]), 'main.csv');
    const res = await fetch(`${base}/api/imports`, { method: 'POST', body: form });
    expect(res.status).toBe(400);
  });

  it('400s for a structurally invalid file', async () => {
    const accountId = await createAccount();
    const form = new FormData();
    form.append('accountId', String(accountId));
    form.append('file', new Blob([Buffer.from('not,a;spankki;file\n')]), 'bad.csv');
    const res = await fetch(`${base}/api/imports`, { method: 'POST', body: form });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/imports/:id', () => {
  it('404s for a missing import', async () => {
    const res = await fetch(`${base}/api/imports/9999`);
    expect(res.status).toBe(404);
  });

  it('returns the same detail shape as the upload response', async () => {
    const accountId = await createAccount();
    const { body: uploadBody } = await uploadMainFixture(accountId);
    const res = await fetch(`${base}/api/imports/${uploadBody.importId}`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.counts).toEqual(uploadBody.counts);
  });
});

describe('review edits + commit', () => {
  it('bulk-applies a group, then commits with allowUncategorized', async () => {
    const accountId = await createAccount();
    const { body: detail } = await uploadMainFixture(accountId);
    const group = detail.groups[0];

    const patchRes = await fetch(
      `${base}/api/imports/${detail.importId}/groups/${encodeURIComponent(group.normalizedCounterparty)}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ categoryId: null, rememberRule: false }),
      },
    );
    expect(patchRes.status).toBe(200);

    const commitRes = await fetch(`${base}/api/imports/${detail.importId}/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    // Without allowUncategorized, plenty of rows are still unlabeled -> 400.
    expect(commitRes.status).toBe(400);

    const commitRes2 = await fetch(`${base}/api/imports/${detail.importId}/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowUncategorized: true }),
    });
    expect(commitRes2.status).toBe(200);
    const commitBody = await json(commitRes2);
    expect(commitBody.inserted).toBe(expected.files.main.rowCount);
  });

  it('patches a single row note and category override', async () => {
    const accountId = await createAccount();
    const { body: detail } = await uploadMainFixture(accountId);
    const row = detail.groups[0].rows[0];

    const res = await fetch(`${base}/api/imports/${detail.importId}/rows/${row.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'test note' }),
    });
    expect(res.status).toBe(200);
    const updated = await json(res);
    const updatedRow = updated.groups
      .flatMap((g: { rows: Array<{ id: number; note: string | null }> }) => g.rows)
      .find((r: { id: number }) => r.id === row.id);
    expect(updatedRow.note).toBe('test note');
  });
});

describe('POST /api/imports/:id/discard', () => {
  it('discards an import and marks it non-committable', async () => {
    const accountId = await createAccount();
    const { body: detail } = await uploadMainFixture(accountId);
    const res = await fetch(`${base}/api/imports/${detail.importId}/discard`, { method: 'POST' });
    expect(res.status).toBe(200);

    const commitRes = await fetch(`${base}/api/imports/${detail.importId}/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowUncategorized: true }),
    });
    expect(commitRes.status).toBe(409);
  });
});

describe('wrong-account duplicate banner data (AC 002-9)', () => {
  it('names the account that already has the rows', async () => {
    const mainId = await createAccount();
    await uploadMainFixture(mainId).then(({ body }) =>
      fetch(`${base}/api/imports/${body.importId}/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ allowUncategorized: true }),
      }),
    );

    const bufferRes = await fetch(`${base}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Buffer', kind: 'buffer', openingBalanceDate: '2025-07-01' }),
    });
    const bufferId = (await json(bufferRes)).id;

    const { body: wrongDetail } = await uploadMainFixture(bufferId);
    expect(wrongDetail.counts.new).toBe(0);
    expect(
      wrongDetail.duplicates.every(
        (d: { duplicateAccountId: number }) => d.duplicateAccountId === mainId,
      ),
    ).toBe(true);
  });
});

describe('POST /api/imports/:id/extend-history (decision 002-E)', () => {
  it('extends the opening balance to cover before-opening rows', async () => {
    const accountId = await createAccount('2025-09-01');
    const { body: detail } = await uploadMainFixture(accountId);
    const excluded = detail.groups
      .flatMap((g: { rows: Array<{ beforeOpening: boolean }> }) => g.rows)
      .filter((r: { beforeOpening: boolean }) => r.beforeOpening);
    expect(excluded.length).toBeGreaterThan(0);

    const res = await fetch(`${base}/api/imports/${detail.importId}/extend-history`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.extendedRowCount).toBe(excluded.length);

    const after = await fetch(`${base}/api/imports/${detail.importId}`).then(json);
    expect(
      after.groups
        .flatMap((g: { rows: Array<{ beforeOpening: boolean }> }) => g.rows)
        .some((r: { beforeOpening: boolean }) => r.beforeOpening),
    ).toBe(false);
  });
});
