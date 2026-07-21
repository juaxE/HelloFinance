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

async function upload(accountId: number, relPath: string, filename: string) {
  const bytes = loadFixture(relPath);
  const form = new FormData();
  form.append('accountId', String(accountId));
  form.append('file', new Blob([bytes]), filename);
  const res = await fetch(`${base}/api/imports`, { method: 'POST', body: form });
  return { res, body: await json(res) };
}

async function uploadMainFixture(accountId: number) {
  return upload(accountId, expected.files.main.path, 'main.csv');
}

async function commit(importId: number, allowUncategorized = true) {
  const res = await fetch(`${base}/api/imports/${importId}/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ allowUncategorized }),
  });
  return { res, body: await json(res) };
}

async function countTransactions(): Promise<number> {
  return (await fetch(`${base}/api/transactions`).then(json)).length;
}

/** Signed cents per payment month over every committed row — the money side. */
async function monthlyCents(): Promise<Record<string, number>> {
  const rows: Array<{ paymentDate: string; amountCents: number }> = await fetch(
    `${base}/api/transactions`,
  ).then(json);
  const byMonth: Record<string, number> = {};
  for (const r of rows) {
    const month = r.paymentDate.slice(0, 7);
    byMonth[month] = (byMonth[month] ?? 0) + r.amountCents;
  }
  return byMonth;
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

  it('409s the assist and reports extendOffered=false when the file ends before opening (AC 002-12)', async () => {
    const gap = expected.openingBalanceBoundary.gap;
    const accountId = await createAccount(gap.openingBalanceDate);
    const bytes = loadFixture(gap.path);
    const form = new FormData();
    form.append('accountId', String(accountId));
    form.append('file', new Blob([bytes]), 'gap.csv');
    const detail = await fetch(`${base}/api/imports`, { method: 'POST', body: form }).then(json);
    expect(detail.beforeOpening.extendOffered).toBe(false);

    const res = await fetch(`${base}/api/imports/${detail.importId}/extend-history`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
  });
});

// --- Proposal 008: pending-import resume + commit-time dedup re-verification

describe('GET /api/imports (proposal 008)', () => {
  it('criterion 1: lists imports newest-first with counts, filters by status, 400s an unknown status', async () => {
    const accountId = await createAccount();
    const { body: first } = await uploadMainFixture(accountId);
    await commit(first.importId);
    const { body: second } = await upload(accountId, expected.files.overlap.path, 'overlap.csv');

    const all = await fetch(`${base}/api/imports`).then(json);
    expect(all.map((i: { id: number }) => i.id)).toEqual([second.importId, first.importId]);
    expect(all[1]).toMatchObject({
      filename: 'main.csv',
      accountId,
      bank: 's-pankki',
      status: 'committed',
      encoding: expected.files.main.encoding,
      rowCount: expected.files.main.rowCount,
      insertedCount: expected.files.main.rowCount,
      duplicateCount: 0,
    });
    expect(typeof all[1].createdAt).toBe('number');

    const pending = await fetch(`${base}/api/imports?status=pending_review`).then(json);
    expect(pending.map((i: { id: number }) => i.id)).toEqual([second.importId]);

    const committed = await fetch(`${base}/api/imports?status=committed`).then(json);
    expect(committed.map((i: { id: number }) => i.id)).toEqual([first.importId]);

    const bad = await fetch(`${base}/api/imports?status=nonsense`);
    expect(bad.status).toBe(400);
  });
});

describe('commit-time dedup re-verification (proposal 008)', () => {
  it('criterion 2: committing staging that went entirely stale inserts nothing and does not error', async () => {
    const accountId = await createAccount();
    const { body: a } = await uploadMainFixture(accountId);
    const { body: b } = await uploadMainFixture(accountId);
    // Both analyzed against an empty transactions table: B believes every row is new.
    expect(b.counts).toEqual({
      total: expected.files.main.rowCount,
      new: expected.files.main.rowCount,
      duplicates: 0,
    });

    await commit(a.importId);
    const afterA = await countTransactions();

    const { res, body } = await commit(b.importId);
    expect(res.status).toBe(200);
    expect(body.inserted).toBe(0);
    expect(body.duplicates).toBe(expected.files.main.rowCount);
    expect(await countTransactions()).toBe(afterA);

    const listed = await fetch(`${base}/api/imports?status=committed`)
      .then(json)
      .then((rows: LooseJson[]) => rows.find((r) => r.id === b.importId));
    expect(listed).toMatchObject({
      status: 'committed',
      insertedCount: 0,
      duplicateCount: expected.files.main.rowCount,
    });
  });

  it('criterion 3: partial overlap inserts exactly the rows that are still new', async () => {
    const accountId = await createAccount();
    const { body: main } = await uploadMainFixture(accountId);
    const { body: overlap } = await upload(accountId, expected.files.overlap.path, 'overlap.csv');
    // Analyzed before main committed, so analyze-time dedup sees nothing.
    expect(overlap.counts.duplicates).toBe(0);
    expect(overlap.counts.new).toBe(expected.dedup.overlapRowCount);

    const { body: mainResult } = await commit(main.importId);
    expect(mainResult.inserted).toBe(expected.dedup.mainRowCount);
    const mainOnlyMonths = await monthlyCents();
    expect(Object.keys(mainOnlyMonths).sort()).toEqual([...expected.files.main.months].sort());

    const { res, body } = await commit(overlap.importId);
    expect(res.status).toBe(200);
    expect(body.inserted).toBe(expected.dedup.overlapNewRows);
    expect(body.duplicates).toBe(expected.dedup.overlapSharedWithMain);
    expect(await countTransactions()).toBe(expected.dedup.unionUniqueArchiveIds);

    // The money side of "re-importing overlap never duplicates" (non-negotiable
    // #4): every month the two files share must hold exactly the cents it held
    // before the overlap commit — a count-only assertion would pass even if the
    // 28 shared rows had been swapped for 28 other rows. The overlap file's 14
    // genuinely new rows are all dated 2026-07, so it is the one new month.
    const bothMonths = await monthlyCents();
    for (const month of expected.files.main.months) {
      expect([month, bothMonths[month]]).toEqual([month, mainOnlyMonths[month]]);
    }
    expect(Object.keys(bothMonths).sort()).toEqual(
      [...expected.files.main.months, '2026-07'].sort(),
    );
  });

  it('criterion 4: an import whose only unlabeled rows went stale commits without allowUncategorized', async () => {
    const accountId = await createAccount();
    const { body: a } = await uploadMainFixture(accountId);
    const { body: b } = await uploadMainFixture(accountId);

    // B is full of unlabeled rows: before A commits, committing it without the
    // flag is a 400.
    const early = await commit(b.importId, false);
    expect(early.res.status).toBe(400);

    await commit(a.importId);

    const { res, body } = await commit(b.importId, false);
    expect(res.status).toBe(200);
    expect(body.inserted).toBe(0);
    expect(body.uncategorized).toBe(0);
  });

  it('criterion 5: re-committing an already-committed import stays an idempotent no-op', async () => {
    const accountId = await createAccount();
    const { body: detail } = await uploadMainFixture(accountId);
    const { body: first } = await commit(detail.importId);
    const before = await countTransactions();

    const { res, body: second } = await commit(detail.importId);
    expect(res.status).toBe(200);
    expect(second).toEqual(first);
    expect(await countTransactions()).toBe(before);
  });
});
