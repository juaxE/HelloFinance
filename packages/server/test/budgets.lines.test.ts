/**
 * Spec 003 stage 3 — envelope and line endpoints.
 *
 * The negative criteria here (12, 13, 18, 19, 23, 25, 26) assert the rejection
 * **and** that the rejected call changed nothing: a 409 that half-applied would
 * be worse than no check at all.
 *
 * Criteria covered: 12 (line half), 13, 18–20, 23–24, 26.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app';
import type { Db } from '../src/db/client';
import { budgetLines, budgets, categories } from '../src/db/schema';
import { createTestDb } from './helpers';

let app: FastifyInstance;
let db: Db;

// Pinned to the first fixture month so every month written here is the current
// one or a later one: past months are read-only (proposal 007), and these
// criteria are about the line rules, not the lock. `MONTH` is the month under
// test throughout, one month ahead of "now"; `CURRENT_MONTH` is where the
// criterion-26 hint is exercised.
const NOW = new Date('2025-07-15T12:00:00.000Z');
const CURRENT_MONTH = '2025-07';
const MONTH = '2025-08';

beforeEach(async () => {
  db = createTestDb();
  app = buildApp(db, { now: () => NOW });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function categoryId(name: string): Promise<number> {
  const row = db.select().from(categories).where(eq(categories.name, name)).get();
  if (!row) throw new Error(`category ${name} not found`);
  return row.id;
}

async function openMonth(month: string) {
  return (await app.inject({ method: 'GET', url: `/api/budgets/${month}?open=1` })).json();
}

type Payload = Record<string, unknown>;

async function postLine(month: string, payload: Payload) {
  return app.inject({ method: 'POST', url: `/api/budgets/${month}/lines`, payload });
}

async function patchLine(month: string, id: number, payload: Payload) {
  return app.inject({ method: 'PATCH', url: `/api/budgets/${month}/lines/${id}`, payload });
}

async function putEnvelopes(month: string, envelopes: Payload[]) {
  return app.inject({
    method: 'PUT',
    url: `/api/budgets/${month}/envelopes`,
    payload: { envelopes },
  });
}

/** Every line in a month, straight from the DB — the state-unchanged oracle. */
function linesOf(month: string) {
  const budget = db.select().from(budgets).where(eq(budgets.month, month)).get();
  if (!budget) return [];
  return db.select().from(budgetLines).where(eq(budgetLines.budgetId, budget.id)).all();
}

function envelopesOf(month: string) {
  return linesOf(month).filter((l) => l.kind === 'envelope');
}

describe('spec 003 — envelope lines (criterion 18)', () => {
  it('criterion 18: creating an envelope produces a line with null match key, null expected day and null templateId', async () => {
    const groceries = await categoryId('Groceries');
    const res = await postLine(MONTH, {
      kind: 'envelope',
      categoryId: groceries,
      amountCents: 40000,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      kind: 'envelope',
      categoryId: groceries,
      amountCents: 40000,
      matchNormalizedCounterparty: null,
      expectedDayOfMonth: null,
      templateId: null,
    });
  });

  it('criterion 18: a second envelope in the same category that month is 409 and leaves the first intact', async () => {
    const groceries = await categoryId('Groceries');
    await postLine(MONTH, { kind: 'envelope', categoryId: groceries, amountCents: 40000 });

    const res = await postLine(MONTH, {
      kind: 'envelope',
      categoryId: groceries,
      amountCents: 55000,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().hint).toMatch(/edit the existing envelope/i);

    const envelopes = envelopesOf(MONTH);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.amountCents).toBe(40000); // untouched
  });

  it('criterion 18: supplying a match key or an expected day on an envelope is 400 and creates nothing', async () => {
    const groceries = await categoryId('Groceries');

    const withKey = await postLine(MONTH, {
      kind: 'envelope',
      categoryId: groceries,
      amountCents: 40000,
      matchNormalizedCounterparty: 'LIDL',
    });
    expect(withKey.statusCode).toBe(400);

    const withDay = await postLine(MONTH, {
      kind: 'envelope',
      categoryId: groceries,
      amountCents: 40000,
      expectedDayOfMonth: 15,
    });
    expect(withDay.statusCode).toBe(400);

    expect(envelopesOf(MONTH)).toHaveLength(0);
  });

  it('criterion 18: re-pointing an envelope at a category that already has one is 409 and changes nothing', async () => {
    const groceries = await categoryId('Groceries');
    const transport = await categoryId('Transport');
    await postLine(MONTH, { kind: 'envelope', categoryId: groceries, amountCents: 40000 });
    const second = await postLine(MONTH, {
      kind: 'envelope',
      categoryId: transport,
      amountCents: 15000,
    });
    const transportLineId = second.json().id;

    const res = await patchLine(MONTH, transportLineId, { categoryId: groceries });
    expect(res.statusCode).toBe(409);

    const line = linesOf(MONTH).find((l) => l.id === transportLineId)!;
    expect(line.categoryId).toBe(transport);
  });
});

describe('spec 003 — ad-hoc lines must be named (criterion 19)', () => {
  it('criterion 19: an ad-hoc line without a match key is 400, creates nothing, and the error points at a raised envelope', async () => {
    const transport = await categoryId('Transport');
    const res = await postLine(MONTH, {
      kind: 'adhoc',
      name: 'Car service',
      categoryId: transport,
      amountCents: 25000,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().hint).toMatch(/envelope/i);
    expect(linesOf(MONTH)).toHaveLength(0);
  });

  it('criterion 19: the same line WITH a counterparty is created and reconciles as a named line', async () => {
    const transport = await categoryId('Transport');
    const res = await postLine(MONTH, {
      kind: 'adhoc',
      name: 'Car service',
      categoryId: transport,
      amountCents: 25000,
      matchNormalizedCounterparty: 'AUTOKORJAAMO OY',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().matchNormalizedCounterparty).toBe('AUTOKORJAAMO OY');

    // No matching transactions exist, so it reconciles as pending — the named
    // behavior, not the envelope behavior.
    const month = await openMonth(MONTH);
    const line = month.lines.find((l: { name: string }) => l.name === 'Car service');
    expect(line.pending).toBe(true);
    expect(line.actualCents).toBe(0);
  });
});

describe('spec 003 — per-kind invariants under PATCH (criterion 12)', () => {
  it('criterion 12: setting a match key on an envelope is 400 and leaves the line unchanged', async () => {
    const groceries = await categoryId('Groceries');
    const created = await postLine(MONTH, {
      kind: 'envelope',
      categoryId: groceries,
      amountCents: 40000,
    });
    const id = created.json().id;

    const res = await patchLine(MONTH, id, { matchNormalizedCounterparty: 'LIDL' });
    expect(res.statusCode).toBe(400);

    const line = linesOf(MONTH).find((l) => l.id === id)!;
    expect(line.matchNormalizedCounterparty).toBeNull();
  });

  it('criterion 12: setting an expected day on an envelope is 400', async () => {
    const groceries = await categoryId('Groceries');
    const created = await postLine(MONTH, {
      kind: 'envelope',
      categoryId: groceries,
      amountCents: 40000,
    });
    const id = created.json().id;

    const res = await patchLine(MONTH, id, { expectedDayOfMonth: 15 });
    expect(res.statusCode).toBe(400);
    expect(linesOf(MONTH).find((l) => l.id === id)!.expectedDayOfMonth).toBeNull();
  });

  it('criterion 12: clearing the match key on an ad-hoc line is 400 and leaves it named', async () => {
    const transport = await categoryId('Transport');
    const created = await postLine(MONTH, {
      kind: 'adhoc',
      name: 'Car service',
      categoryId: transport,
      amountCents: 25000,
      matchNormalizedCounterparty: 'AUTOKORJAAMO OY',
    });
    const id = created.json().id;

    const res = await patchLine(MONTH, id, { matchNormalizedCounterparty: null });
    expect(res.statusCode).toBe(400);
    expect(linesOf(MONTH).find((l) => l.id === id)!.matchNormalizedCounterparty).toBe(
      'AUTOKORJAAMO OY',
    );
  });

  it('criterion 12: clearing the match key on a recurring line is 400', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/recurring-templates',
      payload: {
        name: 'Rent',
        categoryId: await categoryId('Housing'),
        amountCents: 95000,
        intervalMonths: 1,
        expectedDayOfMonth: 5,
        startMonth: '2025-07',
        matchNormalizedCounterparty: 'ASUNTO OY ESIMERKKI',
      },
    });
    await openMonth(MONTH);
    const line = linesOf(MONTH).find((l) => l.kind === 'recurring')!;

    const res = await patchLine(MONTH, line.id, { matchNormalizedCounterparty: null });
    expect(res.statusCode).toBe(400);
    expect(linesOf(MONTH).find((l) => l.id === line.id)!.matchNormalizedCounterparty).toBe(
      'ASUNTO OY ESIMERKKI',
    );
  });

  it('criterion 12: retargeting a named line to a different counterparty succeeds and moves what it consumes', async () => {
    const transport = await categoryId('Transport');
    const created = await postLine(MONTH, {
      kind: 'adhoc',
      name: 'Car service',
      categoryId: transport,
      amountCents: 25000,
      matchNormalizedCounterparty: 'AUTOKORJAAMO OY',
    });
    const id = created.json().id;

    const res = await patchLine(MONTH, id, { matchNormalizedCounterparty: 'MUU KORJAAMO' });
    expect(res.statusCode).toBe(200);
    expect(res.json().matchNormalizedCounterparty).toBe('MUU KORJAAMO');
    expect(linesOf(MONTH).find((l) => l.id === id)!.matchNormalizedCounterparty).toBe(
      'MUU KORJAAMO',
    );
  });
});

describe('spec 003 — duplicate match keys within a month (criterion 13)', () => {
  async function seedRecurringLine(): Promise<void> {
    await app.inject({
      method: 'POST',
      url: '/api/recurring-templates',
      payload: {
        name: 'Rent',
        categoryId: await categoryId('Housing'),
        amountCents: 95000,
        intervalMonths: 1,
        expectedDayOfMonth: 5,
        startMonth: '2025-07',
        matchNormalizedCounterparty: 'ASUNTO OY ESIMERKKI',
      },
    });
    await openMonth(MONTH);
  }

  it('criterion 13: POSTing a second line with a key the month already has is 409 and leaves reconciliation unchanged', async () => {
    await seedRecurringLine();
    const before = await openMonth(MONTH);

    const res = await postLine(MONTH, {
      kind: 'adhoc',
      name: 'Rent again',
      categoryId: await categoryId('Housing'),
      amountCents: 50000,
      matchNormalizedCounterparty: 'ASUNTO OY ESIMERKKI',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().conflictingLine.name).toBe('Rent');

    const after = await openMonth(MONTH);
    expect(linesOf(MONTH)).toHaveLength(1);
    expect(after.totals).toEqual(before.totals);
    expect(after.lines).toEqual(before.lines);
  });

  it('criterion 13: PATCHing an ad-hoc line onto the recurring line key is 409 and leaves reconciliation unchanged', async () => {
    await seedRecurringLine();
    const created = await postLine(MONTH, {
      kind: 'adhoc',
      name: 'Car service',
      categoryId: await categoryId('Transport'),
      amountCents: 25000,
      matchNormalizedCounterparty: 'AUTOKORJAAMO OY',
    });
    const id = created.json().id;
    const before = await openMonth(MONTH);

    const res = await patchLine(MONTH, id, {
      matchNormalizedCounterparty: 'ASUNTO OY ESIMERKKI',
    });
    expect(res.statusCode).toBe(409);

    const after = await openMonth(MONTH);
    expect(linesOf(MONTH).find((l) => l.id === id)!.matchNormalizedCounterparty).toBe(
      'AUTOKORJAAMO OY',
    );
    expect(after.totals).toEqual(before.totals);
    expect(after.lines).toEqual(before.lines);
  });
});

describe('spec 003 — envelope bulk save (criteria 20, 23, 24)', () => {
  it('criterion 20: opening a month returns the previous month as a suggestion and creates no envelope line', async () => {
    const groceries = await categoryId('Groceries');
    await putEnvelopes('2025-07', [{ categoryId: groceries, amountCents: 40000 }]);

    const august = await openMonth('2025-08');
    const candidate = august.envelopeCandidates.find(
      (c: { categoryId: number }) => c.categoryId === groceries,
    );
    expect(candidate.suggestedAmountCents).toBe(40000);
    expect(candidate.envelopeAmountCents).toBeNull();

    // Asserted at the DB level: a suggestion is data for rendering, never a line.
    expect(envelopesOf('2025-08')).toHaveLength(0);
    expect(august.budgeted).toBe(false);
  });

  it('criterion 20: opening a month and leaving it untouched leaves it with no envelope lines', async () => {
    await openMonth('2025-08');
    await openMonth('2025-08');
    expect(envelopesOf('2025-08')).toHaveLength(0);
  });

  it('criterion 20: the first month ever has no suggestions at all', async () => {
    const month = await openMonth('2025-08');
    expect(
      month.envelopeCandidates.every(
        (c: { suggestedAmountCents: number | null }) => c.suggestedAmountCents === null,
      ),
    ).toBe(true);
  });

  it('criterion 20: confirming a suggestion creates nothing until the save, then exactly one envelope with that amount', async () => {
    const groceries = await categoryId('Groceries');
    await putEnvelopes('2025-07', [{ categoryId: groceries, amountCents: 40000 }]);

    // "Confirm" is a client-side state change: the read that backs it must not
    // write. Between the confirm and the save the DB has no envelope.
    const august = await openMonth('2025-08');
    const suggested = august.envelopeCandidates.find(
      (c: { categoryId: number }) => c.categoryId === groceries,
    ).suggestedAmountCents;
    expect(envelopesOf('2025-08')).toHaveLength(0);

    await putEnvelopes('2025-08', [{ categoryId: groceries, amountCents: suggested }]);

    const envelopes = envelopesOf('2025-08');
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.amountCents).toBe(40000);
    expect((await openMonth('2025-08')).budgeted).toBe(true);
  });

  it('criterion 23: envelope candidates exclude Transfer and income-source categories, and PUT rejects them', async () => {
    const month = await openMonth(MONTH);
    const offered: number[] = month.envelopeCandidates.map(
      (c: { categoryId: number }) => c.categoryId,
    );
    const transfer = await categoryId('Transfer');
    const income = await categoryId('Income');

    expect(offered).not.toContain(transfer);
    expect(offered).not.toContain(income);
    expect(offered).toContain(await categoryId('Groceries'));

    for (const categoryIdValue of [transfer, income]) {
      const res = await putEnvelopes(MONTH, [{ categoryId: categoryIdValue, amountCents: 10000 }]);
      expect(res.statusCode).toBe(400);
    }
    expect(envelopesOf(MONTH)).toHaveLength(0);
  });

  it('criterion 23: PUT rejects creating an envelope on an archived category but allows updating and deleting an existing one', async () => {
    const shopping = await categoryId('Shopping');
    // Existing envelope first, then archive the category mid-month.
    await putEnvelopes(MONTH, [{ categoryId: shopping, amountCents: 20000 }]);
    await app.inject({
      method: 'PATCH',
      url: `/api/categories/${shopping}`,
      payload: { archived: true },
    });

    // Updating the stranded envelope still works.
    const update = await putEnvelopes(MONTH, [{ categoryId: shopping, amountCents: 25000 }]);
    expect(update.statusCode).toBe(200);
    expect(envelopesOf(MONTH)[0]!.amountCents).toBe(25000);

    // Deleting it works too.
    const remove = await putEnvelopes(MONTH, [{ categoryId: shopping, amountCents: null }]);
    expect(remove.statusCode).toBe(200);
    expect(envelopesOf(MONTH)).toHaveLength(0);

    // But CREATING a new one on the archived category is rejected.
    const create = await putEnvelopes(MONTH, [{ categoryId: shopping, amountCents: 30000 }]);
    expect(create.statusCode).toBe(400);
    expect(envelopesOf(MONTH)).toHaveLength(0);
  });

  it('criterion 24: PUT is a partial upsert — it creates, updates, deletes by null, and leaves omitted categories untouched', async () => {
    const groceries = await categoryId('Groceries');
    const transport = await categoryId('Transport');
    const health = await categoryId('Health');

    await putEnvelopes(MONTH, [
      { categoryId: groceries, amountCents: 40000 },
      { categoryId: transport, amountCents: 15000 },
      { categoryId: health, amountCents: 5000 },
    ]);
    expect(envelopesOf(MONTH)).toHaveLength(3);

    // Update groceries, delete transport, OMIT health entirely.
    const res = await putEnvelopes(MONTH, [
      { categoryId: groceries, amountCents: 45000 },
      { categoryId: transport, amountCents: null },
    ]);
    expect(res.statusCode).toBe(200);

    const byCategory = new Map(envelopesOf(MONTH).map((l) => [l.categoryId, l.amountCents]));
    expect(byCategory.get(groceries)).toBe(45000);
    expect(byCategory.has(transport)).toBe(false);
    // The omitted category is untouched — a partial save never wipes what the
    // screen did not render.
    expect(byCategory.get(health)).toBe(5000);
  });

  it('criterion 24: an envelope of 0 is saved as a real line, distinct from no envelope', async () => {
    const groceries = await categoryId('Groceries');
    await putEnvelopes(MONTH, [{ categoryId: groceries, amountCents: 0 }]);

    const envelopes = envelopesOf(MONTH);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.amountCents).toBe(0);
    expect((await openMonth(MONTH)).budgeted).toBe(true);
  });
});

describe('spec 003 — targeted insert respects the invariant (criterion 26)', () => {
  it('criterion 26: the addableToMonths hint 409s when the month already holds that key, and succeeds once the ad-hoc line is deleted', async () => {
    const housing = await categoryId('Housing');
    // The current month is materialized and already holds a hand-added ad-hoc
    // line on the counterparty the template is about to claim.
    await openMonth(CURRENT_MONTH);
    const adhoc = await postLine(CURRENT_MONTH, {
      kind: 'adhoc',
      name: 'Rent (manual)',
      categoryId: housing,
      amountCents: 95000,
      matchNormalizedCounterparty: 'ASUNTO OY ESIMERKKI',
    });
    const adhocId = adhoc.json().id;

    const created = await app.inject({
      method: 'POST',
      url: '/api/recurring-templates',
      payload: {
        name: 'Rent',
        categoryId: housing,
        amountCents: 95000,
        intervalMonths: 1,
        expectedDayOfMonth: 5,
        startMonth: '2025-07',
        matchNormalizedCounterparty: 'ASUNTO OY ESIMERKKI',
      },
    });
    const templateId = created.json().id;

    // The hint IS offered — the template is genuinely due in this month.
    expect(created.json().addableToMonths).toContain(CURRENT_MONTH);

    // ...but acting on it runs the same validation as any line insert.
    const blocked = await app.inject({
      method: 'POST',
      url: `/api/budgets/${CURRENT_MONTH}/lines/from-template/${templateId}`,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().conflictingLine.name).toBe('Rent (manual)');
    // Nothing inserted: the month still has exactly the one ad-hoc line.
    expect(linesOf(CURRENT_MONTH)).toHaveLength(1);

    // Deleting the ad-hoc line first makes the same insert succeed.
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/budgets/${CURRENT_MONTH}/lines/${adhocId}`,
    });
    expect(deleted.statusCode).toBe(204);

    const inserted = await app.inject({
      method: 'POST',
      url: `/api/budgets/${CURRENT_MONTH}/lines/from-template/${templateId}`,
    });
    expect(inserted.statusCode).toBe(201);
    expect(inserted.json()).toMatchObject({
      kind: 'recurring',
      templateId,
      matchNormalizedCounterparty: 'ASUNTO OY ESIMERKKI',
    });
    expect(linesOf(CURRENT_MONTH)).toHaveLength(1);
  });
});

describe('spec 003 — line routes are scoped to the month that addresses them', () => {
  /**
   * Resolving a line by `id` alone let a request against one month mutate
   * another month's lines. Already-materialized months are a historical record
   * and line deletion is durable by design, so a cross-month write is
   * unrecoverable — the wrong month must not find the line at all.
   */
  async function envelopeIn(month: string, category: string): Promise<number> {
    await openMonth(month);
    const res = await postLine(month, {
      kind: 'envelope',
      categoryId: await categoryId(category),
      amountCents: 40000,
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  it('DELETE addressed to the wrong month is 404 and leaves the line intact', async () => {
    const id = await envelopeIn('2026-05', 'Groceries');
    await openMonth(MONTH);

    const res = await app.inject({ method: 'DELETE', url: `/api/budgets/${MONTH}/lines/${id}` });

    expect(res.statusCode).toBe(404);
    expect(linesOf('2026-05').map((l) => l.id)).toContain(id);
  });

  it('PATCH addressed to the wrong month is 404 and leaves the line unchanged', async () => {
    const id = await envelopeIn('2026-05', 'Groceries');
    await openMonth(MONTH);

    const res = await patchLine(MONTH, id, { amountCents: 999 });

    expect(res.statusCode).toBe(404);
    expect(linesOf('2026-05').find((l) => l.id === id)!.amountCents).toBe(40000);
  });

  it('the same calls addressed to the line’s own month succeed', async () => {
    const id = await envelopeIn('2026-05', 'Groceries');

    expect((await patchLine('2026-05', id, { amountCents: 12345 })).statusCode).toBe(200);
    expect(linesOf('2026-05').find((l) => l.id === id)!.amountCents).toBe(12345);

    const del = await app.inject({ method: 'DELETE', url: `/api/budgets/2026-05/lines/${id}` });
    expect(del.statusCode).toBe(204);
    expect(linesOf('2026-05').map((l) => l.id)).not.toContain(id);
  });
});

describe('spec 003 — month creation on GET (decision 003-C)', () => {
  it('an absent non-current month that is only glanced at returns an uncreated marker and is not materialized', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/budgets/2025-08' });
    expect(res.json()).toEqual({ month: '2025-08', uncreated: true, closed: false });
    expect(db.select().from(budgets).all()).toHaveLength(0);
  });

  it('the current month auto-materializes even without an explicit open', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/budgets/${CURRENT_MONTH}` });
    expect(res.json().uncreated).toBeUndefined();
    expect(res.json().month).toBe(CURRENT_MONTH);
    expect(db.select().from(budgets).all()).toHaveLength(1);
  });
});
