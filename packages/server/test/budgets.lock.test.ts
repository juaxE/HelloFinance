/**
 * Proposal 007 — the past-month write lock: a month closes when it ends.
 *
 * A closed month's **plan** is a historical record: no materialization, no
 * lines, no envelopes, no notes. Its **actuals** are not frozen — they are never
 * stored, so they keep recomputing from transactions (criterion 3).
 *
 * History that a test needs "written back then" is written through a second app
 * whose clock is pinned inside that month (`appAt`) — the honest simulation of
 * a month planned while it was still open, and the only way to build one now.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app';
import type { Db } from '../src/db/client';
import { materializeMonth } from '../src/budgets/materialize';
import { budgetLines, budgets, categories, transactions } from '../src/db/schema';
import { createTestDb, EXPECTED, seedFixtureApp } from './helpers';

let app: FastifyInstance;
let db: Db;

const NOW = new Date('2026-06-15T12:00:00.000Z');
const CURRENT_MONTH = '2026-06';
const PAST_MONTH = '2026-05';
const FUTURE_MONTH = '2026-07';

beforeEach(async () => {
  db = createTestDb();
  seedFixtureApp(db);
  app = buildApp(db, { now: () => NOW });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function categoryId(name: string): number {
  const row = db.select().from(categories).where(eq(categories.name, name)).get();
  if (!row) throw new Error(`category ${name} not found`);
  return row.id;
}

/** An app whose "now" sits inside `month` — writes through it are that month's own. */
async function appAt<T>(month: string, fn: (pinned: FastifyInstance) => Promise<T>): Promise<T> {
  const pinned = buildApp(db, { now: () => new Date(`${month}-15T12:00:00.000Z`) });
  await pinned.ready();
  try {
    return await fn(pinned);
  } finally {
    await pinned.close();
  }
}

async function getMonth(month: string, instance: FastifyInstance = app) {
  return (await instance.inject({ method: 'GET', url: `/api/budgets/${month}?open=1` })).json();
}

/**
 * A past month planned back when it was current: one envelope, one ad-hoc line,
 * a month note — one instance of every writable thing the lock now covers.
 */
async function planHistory(month: string): Promise<{ envelopeId: number; adhocId: number }> {
  return appAt(month, async (pinned) => {
    await pinned.inject({ method: 'POST', url: '/api/budgets', payload: { month } });
    await pinned.inject({
      method: 'PUT',
      url: `/api/budgets/${month}/envelopes`,
      payload: { envelopes: [{ categoryId: categoryId('Groceries'), amountCents: 40000 }] },
    });
    const adhoc = await pinned.inject({
      method: 'POST',
      url: `/api/budgets/${month}/lines`,
      payload: {
        kind: 'adhoc',
        name: 'Car service',
        categoryId: categoryId('Transport'),
        amountCents: 25000,
        matchNormalizedCounterparty: 'AUTOKORJAAMO OY',
      },
    });
    await pinned.inject({
      method: 'PATCH',
      url: `/api/budgets/${month}`,
      payload: { note: 'planned while it was open' },
    });
    const envelope = db
      .select()
      .from(budgetLines)
      .all()
      .find((l) => l.kind === 'envelope')!;
    return { envelopeId: envelope.id, adhocId: adhoc.json().id };
  });
}

describe('proposal 007 — closed months reject every write (criterion 1)', () => {
  it('criterion 1: every budgets write route 409s on a past month and changes nothing', async () => {
    const { envelopeId, adhocId } = await planHistory(PAST_MONTH);
    const groceries = categoryId('Groceries');
    const before = await getMonth(PAST_MONTH);

    // A template due in the month, so the from-template insert fails on the
    // lock rather than on "not due".
    const template = await app.inject({
      method: 'POST',
      url: '/api/recurring-templates',
      payload: {
        name: 'Newspaper',
        categoryId: categoryId('Other'),
        amountCents: 2500,
        intervalMonths: 1,
        expectedDayOfMonth: 5,
        startMonth: '2025-07',
        matchNormalizedCounterparty: 'HELSINGIN SANOMAT',
      },
    });
    const templateId = template.json().id;

    const writes: [string, InjectOptions][] = [
      ['materialize', { method: 'POST', url: '/api/budgets', payload: { month: PAST_MONTH } }],
      [
        'envelopes',
        {
          method: 'PUT',
          url: `/api/budgets/${PAST_MONTH}/envelopes`,
          payload: { envelopes: [{ categoryId: groceries, amountCents: 99900 }] },
        },
      ],
      [
        'add line',
        {
          method: 'POST',
          url: `/api/budgets/${PAST_MONTH}/lines`,
          payload: {
            kind: 'adhoc',
            name: 'Late addition',
            categoryId: categoryId('Health'),
            amountCents: 1000,
            matchNormalizedCounterparty: 'ELIXIA HELSINKI',
          },
        },
      ],
      [
        'patch line amount',
        {
          method: 'PATCH',
          url: `/api/budgets/${PAST_MONTH}/lines/${envelopeId}`,
          payload: { amountCents: 99900 },
        },
      ],
      [
        // The lock covers notes too (owner decision): a line note is part of the
        // record of what was planned then.
        'patch line note',
        {
          method: 'PATCH',
          url: `/api/budgets/${PAST_MONTH}/lines/${adhocId}`,
          payload: { note: 'rewriting history' },
        },
      ],
      ['delete line', { method: 'DELETE', url: `/api/budgets/${PAST_MONTH}/lines/${adhocId}` }],
      [
        'month note',
        { method: 'PATCH', url: `/api/budgets/${PAST_MONTH}`, payload: { note: 'rewritten' } },
      ],
      [
        'from template',
        {
          method: 'POST',
          url: `/api/budgets/${PAST_MONTH}/lines/from-template/${templateId}`,
        },
      ],
    ];

    for (const [label, injection] of writes) {
      const res = await app.inject(injection);
      expect(res.statusCode, label).toBe(409);
      expect(res.json().error, label).toContain('closed');
    }

    // Nothing moved: the whole reconciliation is byte-equal, note included.
    expect(await getMonth(PAST_MONTH)).toEqual(before);
  });

  it('criterion 1: the two routes that materialize as a side effect are refused before they do it', async () => {
    // `PUT …/envelopes` and `POST …/lines` create the month on the way in, so
    // the guard has to run first: checked after, a 409 would still leave a
    // closed month materialized behind it. Asserted on a month that does NOT
    // exist yet — against an already-materialized one the ordering is invisible.
    const unplanned = '2026-03';

    const envelopes = await app.inject({
      method: 'PUT',
      url: `/api/budgets/${unplanned}/envelopes`,
      payload: { envelopes: [{ categoryId: categoryId('Groceries'), amountCents: 40000 }] },
    });
    expect(envelopes.statusCode).toBe(409);

    const line = await app.inject({
      method: 'POST',
      url: `/api/budgets/${unplanned}/lines`,
      payload: {
        kind: 'adhoc',
        name: 'Car service',
        categoryId: categoryId('Transport'),
        amountCents: 25000,
        matchNormalizedCounterparty: 'AUTOKORJAAMO OY',
      },
    });
    expect(line.statusCode).toBe(409);

    expect(db.select().from(budgets).where(eq(budgets.month, unplanned)).get()).toBeUndefined();
  });
});

describe('proposal 007 — reading a closed month (criteria 2, 3)', () => {
  it('criterion 2: GET ?open=1 on an unmaterialized past month returns the uncreated marker and creates no budgets row', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/budgets/${PAST_MONTH}?open=1` });

    expect(res.json()).toEqual({ month: PAST_MONTH, uncreated: true, closed: true });
    expect(db.select().from(budgets).all()).toHaveLength(0);
  });

  it('criterion 3: a materialized past month still reconciles in full, and its actuals move when a transaction in it is relabelled', async () => {
    const fixture = EXPECTED.needsReview; // the 2026-04 uncategorized payback
    const restaurants = categoryId('Restaurants & Cafés');
    await appAt(fixture.month, async (pinned) => {
      await pinned.inject({
        method: 'PUT',
        url: `/api/budgets/${fixture.month}/envelopes`,
        payload: { envelopes: [{ categoryId: restaurants, amountCents: 20000 }] },
      });
    });

    const envelopeOf = (month: { lines: { kind: string; actualCents: number }[] }) =>
      month.lines.find((l) => l.kind === 'envelope')!;

    const before = await getMonth(fixture.month);
    expect(before.closed).toBe(true);
    // The seeded bills materialized into it too — a closed month reconciles in
    // full, not as a stub.
    expect(before.lines.filter((l: { kind: string }) => l.kind === 'recurring').length)
      .toBeGreaterThan(0);
    expect(before.totals.expenseCents).toBe(fixture.monthExpenseCentsWithRow);
    expect(
      before.needsReview.some((r: { amountCents: number }) => r.amountCents === fixture.amountCents),
    ).toBe(true);

    // The actuals side stays live: relabelling a transaction in the closed month
    // is allowed and the month's reconciliation follows it.
    const row = db
      .select()
      .from(transactions)
      .where(eq(transactions.archiveId, fixture.archiveId))
      .get()!;
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${row.id}`,
      payload: { categoryId: restaurants, scope: 'one_off' },
    });
    expect(patched.statusCode).toBe(200);

    const after = await getMonth(fixture.month);
    // The plan is frozen...
    expect(after.lines.map((l: { id: number; amountCents: number }) => [l.id, l.amountCents])).toEqual(
      before.lines.map((l: { id: number; amountCents: number }) => [l.id, l.amountCents]),
    );
    // ...while the envelope's actual nets the payback down and the row leaves
    // the needs-review bucket.
    expect(envelopeOf(after).actualCents).toBe(envelopeOf(before).actualCents - fixture.amountCents);
    expect(
      after.needsReview.some((r: { amountCents: number }) => r.amountCents === fixture.amountCents),
    ).toBe(false);
  });
});

describe('proposal 007 — the lock stops at the current month (criteria 4, 6)', () => {
  it('criterion 4: the current month and a future month accept the writes the past month rejected', async () => {
    for (const month of [CURRENT_MONTH, FUTURE_MONTH]) {
      const created = await app.inject({
        method: 'POST',
        url: '/api/budgets',
        payload: { month },
      });
      expect(created.statusCode, month).toBe(201);

      const envelopes = await app.inject({
        method: 'PUT',
        url: `/api/budgets/${month}/envelopes`,
        payload: { envelopes: [{ categoryId: categoryId('Groceries'), amountCents: 40000 }] },
      });
      expect(envelopes.statusCode, month).toBe(200);

      const line = await app.inject({
        method: 'POST',
        url: `/api/budgets/${month}/lines`,
        payload: {
          kind: 'adhoc',
          name: 'Car service',
          categoryId: categoryId('Transport'),
          amountCents: 25000,
          matchNormalizedCounterparty: 'AUTOKORJAAMO OY',
        },
      });
      expect(line.statusCode, month).toBe(201);

      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/budgets/${month}/lines/${line.json().id}`,
        payload: { note: 'still open' },
      });
      expect(patched.statusCode, month).toBe(200);

      const note = await app.inject({
        method: 'PATCH',
        url: `/api/budgets/${month}`,
        payload: { note: 'still open' },
      });
      expect(note.statusCode, month).toBe(200);

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/budgets/${month}/lines/${line.json().id}`,
      });
      expect(deleted.statusCode, month).toBe(204);

      expect((await getMonth(month)).closed).toBe(false);
    }
  });

  it('criterion 6: on the 1st of a month the previous month is already locked — the boundary is strict', async () => {
    // Local time, not UTC: `monthOf` reads the clock in local time (it is the
    // user's calendar that decides which month it is), so a UTC instant one
    // second past midnight is still the previous month west of Greenwich — the
    // boundary this criterion is about would then be asserted upside down.
    const rollover = buildApp(db, { now: () => new Date(2026, 5, 1, 0, 0, 1) });
    await rollover.ready();
    try {
      const may = await rollover.inject({
        method: 'POST',
        url: '/api/budgets',
        payload: { month: '2026-05' },
      });
      expect(may.statusCode).toBe(409);

      const june = await rollover.inject({
        method: 'POST',
        url: '/api/budgets',
        payload: { month: '2026-06' },
      });
      expect(june.statusCode).toBe(201);
    } finally {
      await rollover.close();
    }
  });
});

describe('proposal 007 — materializeMonth refuses a closed month (criterion 5)', () => {
  it('criterion 5: materializeMonth called directly with a past month throws and creates nothing', () => {
    expect(() => materializeMonth(db, '2026-05', CURRENT_MONTH)).toThrow(/closed/);
    expect(db.select().from(budgets).all()).toHaveLength(0);
  });

  it('criterion 5: it still returns an already-materialized past month, so reads never hit the throw', async () => {
    await planHistory(PAST_MONTH);

    const { budget, created } = materializeMonth(db, PAST_MONTH, CURRENT_MONTH);

    expect(created).toBe(false);
    expect(budget.month).toBe(PAST_MONTH);
  });
});
