/**
 * Spec 003 stage 1 — templates and month materialization.
 *
 * Test names carry their acceptance-criterion number so a criterion can be
 * traced to its proof. Criteria covered here: 1–5, 8–9, 15, 25, and the
 * template half of 12.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app';
import type { Db } from '../src/db/client';
import { budgetLines, budgets, categories } from '../src/db/schema';
import { createTestDb, EXPECTED, FIXTURE_MONTHS } from './helpers';

let app: FastifyInstance;
let db: Db;

// Pinned "now": the fixtures run 2025-07..2026-06, so a fixed current month
// keeps the 003-N non-ended set and the review-Q1 hint deterministic.
const NOW = new Date('2026-03-15T12:00:00.000Z');
const CURRENT_MONTH = '2026-03';

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

type TemplateInput = {
  name?: string;
  categoryName?: string;
  amountCents?: number;
  intervalMonths?: number;
  expectedDayOfMonth?: number;
  startMonth?: string;
  endMonth?: string | null;
  matchNormalizedCounterparty?: string;
  note?: string | null;
};

async function createTemplate(input: TemplateInput = {}) {
  const payload = {
    name: input.name ?? 'Rent',
    categoryId: await categoryId(input.categoryName ?? 'Housing'),
    amountCents: input.amountCents ?? 95000,
    intervalMonths: input.intervalMonths ?? 1,
    expectedDayOfMonth: input.expectedDayOfMonth ?? 5,
    startMonth: input.startMonth ?? '2025-07',
    ...(input.endMonth !== undefined && { endMonth: input.endMonth }),
    matchNormalizedCounterparty: input.matchNormalizedCounterparty ?? 'ASUNTO OY ESIMERKKI',
    ...(input.note !== undefined && { note: input.note }),
  };
  return app.inject({ method: 'POST', url: '/api/recurring-templates', payload });
}

/**
 * Materialize a month. Past months are read-only (proposal 007), so a month
 * this file needs as **history** is created through a second app whose clock is
 * pinned inside it — the honest simulation of a month materialized back when it
 * was current, and the only way one can come into existence now. Months from
 * `CURRENT_MONTH` on go through the app under test.
 */
async function materialize(month: string) {
  if (month >= CURRENT_MONTH) {
    return app.inject({ method: 'POST', url: '/api/budgets', payload: { month } });
  }
  const back = buildApp(db, { now: () => new Date(`${month}-15T12:00:00.000Z`) });
  await back.ready();
  try {
    return await back.inject({ method: 'POST', url: '/api/budgets', payload: { month } });
  } finally {
    await back.close();
  }
}

function linesOfMonth(month: string) {
  const budget = db.select().from(budgets).where(eq(budgets.month, month)).get();
  if (!budget) return [];
  return db.select().from(budgetLines).where(eq(budgetLines.budgetId, budget.id)).all();
}

describe('spec 003 — materialization', () => {
  it('criterion 1: materializing creates one line per due template with snapshotted values, and re-materializing is a no-op', async () => {
    await createTemplate({ name: 'Rent', amountCents: 95000, matchNormalizedCounterparty: 'RENT' });
    await createTemplate({
      name: 'Gym',
      categoryName: 'Health',
      amountCents: 4990,
      matchNormalizedCounterparty: 'ELIXIA HELSINKI',
    });
    // Quarterly, anchored 2025-07 -> due 2025-10, not 2025-11.
    await createTemplate({
      name: 'Storage',
      categoryName: 'Other',
      amountCents: 8700,
      intervalMonths: 3,
      matchNormalizedCounterparty: 'PELICAN SELF STORAGE',
    });

    const first = await materialize('2025-10');
    expect(first.statusCode).toBe(201);

    const lines = linesOfMonth('2025-10');
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.name).sort()).toEqual(['Gym', 'Rent', 'Storage']);
    // Snapshot: the per-occurrence amount is copied as-is, no division.
    expect(lines.find((l) => l.name === 'Storage')!.amountCents).toBe(8700);
    expect(lines.every((l) => l.kind === 'recurring')).toBe(true);
    expect(lines.every((l) => l.templateId !== null)).toBe(true);

    // A user edit must survive re-materialization.
    const rent = lines.find((l) => l.name === 'Rent')!;
    db.update(budgetLines)
      .set({ amountCents: 99000 })
      .where(eq(budgetLines.id, rent.id))
      .run();

    const second = await materialize('2025-10');
    expect(second.statusCode).toBe(200);
    const after = linesOfMonth('2025-10');
    expect(after).toHaveLength(3);
    expect(after.find((l) => l.name === 'Rent')!.amountCents).toBe(99000);
  });

  it('criterion 1: a quarterly template is due only every third month from its anchor, a yearly one only in its anniversary month', async () => {
    await createTemplate({
      name: 'Storage',
      intervalMonths: 3,
      startMonth: '2025-07',
      matchNormalizedCounterparty: 'PELICAN SELF STORAGE',
    });
    await createTemplate({
      name: 'Insurance',
      intervalMonths: 12,
      startMonth: '2025-10',
      matchNormalizedCounterparty: 'LÄHITAPIOLA',
    });

    const dueQuarterly = ['2025-07', '2025-10', '2026-01', '2026-04'];
    const notDueQuarterly = ['2025-08', '2025-09', '2025-11', '2025-12', '2026-02', '2026-03'];

    for (const month of [...dueQuarterly, ...notDueQuarterly, '2026-10']) {
      await materialize(month);
    }

    for (const month of dueQuarterly) {
      expect(linesOfMonth(month).map((l) => l.name)).toContain('Storage');
    }
    for (const month of notDueQuarterly) {
      expect(linesOfMonth(month).map((l) => l.name)).not.toContain('Storage');
    }
    // Yearly: anniversary months only.
    expect(linesOfMonth('2025-10').map((l) => l.name)).toContain('Insurance');
    expect(linesOfMonth('2026-10').map((l) => l.name)).toContain('Insurance');
    for (const month of ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04']) {
      expect(linesOfMonth(month).map((l) => l.name)).not.toContain('Insurance');
    }
  });

  it('criterion 3 (materialization half): the yearly and quarterly fixture templates materialize exactly in their due months, with no monthly division', async () => {
    const { yearly, quarterly } = EXPECTED.recurringNonMonthly;

    await createTemplate({
      name: 'Home insurance',
      categoryName: 'Other',
      amountCents: -yearly.amountCentsEach, // planned amounts are positive magnitudes
      intervalMonths: yearly.intervalMonths,
      startMonth: yearly.months[0]!,
      matchNormalizedCounterparty: yearly.normalizedCounterparty,
    });
    await createTemplate({
      name: 'Self storage',
      categoryName: 'Other',
      amountCents: -quarterly.amountCentsEach,
      intervalMonths: quarterly.intervalMonths,
      startMonth: quarterly.months[0]!,
      matchNormalizedCounterparty: quarterly.normalizedCounterparty,
    });

    const allMonths = FIXTURE_MONTHS;
    for (const month of allMonths) await materialize(month);

    for (const month of allMonths) {
      const keys = linesOfMonth(month).map((l) => l.matchNormalizedCounterparty);
      expect(keys.includes(yearly.normalizedCounterparty)).toBe(yearly.months.includes(month));
      expect(keys.includes(quarterly.normalizedCounterparty)).toBe(
        quarterly.months.includes(month),
      );
    }

    // The per-occurrence charge lands whole in its due month — never divided.
    const yearlyLine = linesOfMonth(yearly.months[0]!).find(
      (l) => l.matchNormalizedCounterparty === yearly.normalizedCounterparty,
    )!;
    expect(yearlyLine.amountCents).toBe(60000);
    const quarterlyLine = linesOfMonth(quarterly.months[0]!).find(
      (l) => l.matchNormalizedCounterparty === quarterly.normalizedCounterparty,
    )!;
    expect(quarterlyLine.amountCents).toBe(8700);
  });

  it('criterion 2: a template ended before M, or starting after M, produces no line in M', async () => {
    await createTemplate({
      name: 'Ended',
      startMonth: '2025-07',
      endMonth: '2025-09',
      matchNormalizedCounterparty: 'ENDED CO',
    });
    await createTemplate({
      name: 'Future',
      startMonth: '2026-05',
      matchNormalizedCounterparty: 'FUTURE CO',
    });

    await materialize('2025-12');
    const names = linesOfMonth('2025-12').map((l) => l.name);
    expect(names).not.toContain('Ended');
    expect(names).not.toContain('Future');

    // A template that has not ended produces a line inside its active window.
    await materialize('2026-05');
    expect(linesOfMonth('2026-05').map((l) => l.name)).toContain('Future');

    // Inside its own window it DOES produce a line — because materializing
    // 2025-08 now means materializing it back in 2025-08, when the template had
    // not ended yet, and that month keeps its lines forever (criterion 15).
    // The case decision 003-N's non-ended filter used to guard was
    // materializing such a month *today*; proposal 007 closed that path
    // outright, and every month still open is past every ended template's
    // endMonth, so an ended template is never due in one.
    await materialize('2025-08');
    expect(linesOfMonth('2025-08').map((l) => l.name)).toContain('Ended');
  });

  it('an ended template and its replacement cannot both materialize under one match key', async () => {
    await createTemplate({
      name: 'Old insurer',
      amountCents: 60000,
      startMonth: '2025-07',
      endMonth: '2026-01',
      matchNormalizedCounterparty: 'LAHITAPIOLA',
    });
    // A month planned while the old provider was still live holds its line, and
    // keeps it: that is the historical record, and it is now the only way a
    // month inside the ended window can exist at all.
    await materialize('2025-09');
    expect(linesOfMonth('2025-09').map((l) => l.name)).toEqual(['Old insurer']);

    // Accepted because the first has ended — the carve-out that makes switching
    // providers possible without abandoning the counterparty.
    await createTemplate({
      name: 'New insurer',
      amountCents: 70000,
      startMonth: '2025-07',
      matchNormalizedCounterparty: 'LAHITAPIOLA',
    });

    // Every month that can still be materialized is the current one or later,
    // i.e. after the ended template's endMonth — so it is due there alone.
    await materialize(CURRENT_MONTH);

    const keyed = linesOfMonth(CURRENT_MONTH).filter(
      (l) => l.matchNormalizedCounterparty === 'LAHITAPIOLA',
    );
    expect(keyed).toHaveLength(1);
    expect(keyed[0]!.name).toBe('New insurer');

    // The bill is planned once, at its real amount — not 1 300,00 €.
    const month = await app.inject({ method: 'GET', url: `/api/budgets/${CURRENT_MONTH}` });
    expect(month.json().totals.plannedCents).toBe(70000);
    // ...and the old month is untouched by the replacement.
    expect(linesOfMonth('2025-09').map((l) => l.name)).toEqual(['Old insurer']);
  });

  it('criterion 4: editing a template amount leaves already-materialized months untouched and applies to a later due month', async () => {
    const created = await createTemplate({
      name: 'Rent',
      amountCents: 95000,
      matchNormalizedCounterparty: 'RENT',
    });
    const templateId = created.json().id;

    await materialize('2025-08');
    expect(linesOfMonth('2025-08')[0]!.amountCents).toBe(95000);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/recurring-templates/${templateId}`,
      payload: { amountCents: 99000 },
    });
    expect(patched.statusCode).toBe(200);

    // Historical record: unchanged.
    expect(linesOfMonth('2025-08')[0]!.amountCents).toBe(95000);
    // A freshly materialized later month reflects the edit.
    await materialize('2025-09');
    expect(linesOfMonth('2025-09')[0]!.amountCents).toBe(99000);
  });

  it('criterion 5: a template made due in the current already-materialized month is surfaced as addable to it', async () => {
    await materialize(CURRENT_MONTH);
    await materialize('2025-08'); // a past month, must NOT be offered
    await materialize('2026-05'); // a future month, IS offered

    const created = await createTemplate({
      name: 'Newspaper',
      startMonth: '2025-07',
      matchNormalizedCounterparty: 'HELSINGIN SANOMAT',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().addableToMonths).toEqual([CURRENT_MONTH, '2026-05']);

    // The hint is a hint: it does not itself insert anything.
    expect(linesOfMonth(CURRENT_MONTH).map((l) => l.name)).not.toContain('Newspaper');
  });

  it('criterion 5: deleting a materialized recurring line is durable across re-open and re-materialize', async () => {
    await createTemplate({ name: 'Rent', matchNormalizedCounterparty: 'RENT' });
    await materialize('2025-08');
    const line = linesOfMonth('2025-08')[0]!;

    db.delete(budgetLines).where(eq(budgetLines.id, line.id)).run();
    expect(linesOfMonth('2025-08')).toHaveLength(0);

    await materialize('2025-08');
    await materialize('2025-08');
    // The month row already exists, so nothing regenerates it — by design.
    expect(linesOfMonth('2025-08')).toHaveLength(0);
  });

  it('criterion 8: expected day 31 clamps to 30 in a 30-day month and to 28/29 in February', async () => {
    await createTemplate({
      name: 'Loan',
      expectedDayOfMonth: 31,
      startMonth: '2024-01',
      matchNormalizedCounterparty: 'LOAN CO',
    });

    await materialize('2025-01'); // 31 days -> unchanged
    await materialize('2025-06'); // 30 days -> 30
    await materialize('2025-02'); // 28 days -> 28
    await materialize('2024-02'); // leap year -> 29

    expect(linesOfMonth('2025-01')[0]!.expectedDayOfMonth).toBe(31);
    expect(linesOfMonth('2025-06')[0]!.expectedDayOfMonth).toBe(30);
    expect(linesOfMonth('2025-02')[0]!.expectedDayOfMonth).toBe(28);
    expect(linesOfMonth('2024-02')[0]!.expectedDayOfMonth).toBe(29);
  });

  it('criterion 9: a note is snapshotted onto the line, and note edits do not cross between template and line', async () => {
    const created = await createTemplate({
      name: 'Insurance',
      note: 'home contents cover',
      matchNormalizedCounterparty: 'LÄHITAPIOLA',
    });
    const templateId = created.json().id;

    await materialize('2025-08');
    const line = linesOfMonth('2025-08')[0]!;
    expect(line.note).toBe('home contents cover');

    // Editing the line does not touch the template.
    db.update(budgetLines).set({ note: 'raised this month' }).where(eq(budgetLines.id, line.id)).run();
    const template = await app.inject({ method: 'GET', url: '/api/recurring-templates' });
    expect(template.json()[0].note).toBe('home contents cover');

    // Editing the template does not touch an already-materialized line.
    await app.inject({
      method: 'PATCH',
      url: `/api/recurring-templates/${templateId}`,
      payload: { note: 'switched provider' },
    });
    expect(linesOfMonth('2025-08')[0]!.note).toBe('raised this month');
  });
});

describe('spec 003 — template rules (003-L, 003-N, 003-H)', () => {
  it('criterion 12: POST /api/recurring-templates without a match key is rejected 400 and creates nothing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/recurring-templates',
      payload: {
        name: 'Groceries goal',
        categoryId: await categoryId('Groceries'),
        amountCents: 40000,
        intervalMonths: 1,
        expectedDayOfMonth: 1,
        startMonth: '2025-07',
      },
    });
    expect(res.statusCode).toBe(400);
    // The message points at envelopes rather than dead-ending.
    expect(res.json().hint).toMatch(/envelope/i);

    const listed = await app.inject({ method: 'GET', url: '/api/recurring-templates' });
    expect(listed.json()).toHaveLength(0);
  });

  it('criterion 12: PATCH cannot clear a template match key', async () => {
    const created = await createTemplate({ matchNormalizedCounterparty: 'RENT' });
    const id = created.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/recurring-templates/${id}`,
      payload: { matchNormalizedCounterparty: null },
    });
    expect(res.statusCode).toBe(400);

    const listed = await app.inject({ method: 'GET', url: '/api/recurring-templates' });
    expect(listed.json()[0].matchNormalizedCounterparty).toBe('RENT');
  });

  it('criterion 25: a second non-ended template reusing a match key is 409, names the existing template, and creates nothing', async () => {
    await createTemplate({ name: 'Electricity', matchNormalizedCounterparty: 'HELEN OY' });

    const res = await createTemplate({
      name: 'District heating',
      matchNormalizedCounterparty: 'HELEN OY',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('Electricity');
    expect(res.json().conflictingTemplate.name).toBe('Electricity');

    const listed = await app.inject({ method: 'GET', url: '/api/recurring-templates' });
    expect(listed.json()).toHaveLength(1);
  });

  it('criterion 25: PATCHing an existing template onto a used match key is 409 and leaves it unchanged', async () => {
    await createTemplate({ name: 'Electricity', matchNormalizedCounterparty: 'HELEN OY' });
    const other = await createTemplate({ name: 'Water', matchNormalizedCounterparty: 'HSY VESI' });
    const otherId = other.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/recurring-templates/${otherId}`,
      payload: { matchNormalizedCounterparty: 'HELEN OY' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().conflictingTemplate.name).toBe('Electricity');

    const listed = await app.inject({ method: 'GET', url: '/api/recurring-templates' });
    const water = listed.json().find((t: { name: string }) => t.name === 'Water');
    expect(water.matchNormalizedCounterparty).toBe('HSY VESI');
  });

  it('criterion 25: a template ended in the past does not block reusing its key', async () => {
    // endMonth 2026-01 is before the pinned current month 2026-03 -> ended.
    const ended = await createTemplate({
      name: 'Old insurer',
      endMonth: '2026-01',
      matchNormalizedCounterparty: 'LÄHITAPIOLA',
    });
    expect(ended.statusCode).toBe(201);

    const reused = await createTemplate({
      name: 'New insurer',
      matchNormalizedCounterparty: 'LÄHITAPIOLA',
    });
    expect(reused.statusCode).toBe(201);
  });

  it('criterion 25: materializing a month from the full template set produces at most one line per match key', async () => {
    // The seeded template set, all distinct keys — the uniqueness rule is what
    // makes this true by construction, so assert it over a real materialization
    // rather than inferring it from the 409.
    await createTemplate({ name: 'Rent', matchNormalizedCounterparty: 'ASUNTO OY ESIMERKKI' });
    await createTemplate({
      name: 'Gym',
      categoryName: 'Health',
      matchNormalizedCounterparty: 'ELIXIA HELSINKI',
    });
    await createTemplate({
      name: 'Storage',
      categoryName: 'Other',
      intervalMonths: 3,
      matchNormalizedCounterparty: 'PELICAN SELF STORAGE',
    });
    await createTemplate({
      name: 'Insurance',
      categoryName: 'Other',
      intervalMonths: 12,
      startMonth: '2025-10',
      matchNormalizedCounterparty: 'LÄHITAPIOLA',
    });
    await createTemplate({
      name: 'Netflix',
      categoryName: 'Subscriptions',
      matchNormalizedCounterparty: 'NETFLIX.COM',
    });

    await materialize('2025-10'); // every cadence lands here
    const keys = linesOfMonth('2025-10').map((l) => l.matchNormalizedCounterparty);
    expect(keys).toHaveLength(5);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('criterion 15: DELETE is 409 once a template has materialized a line, and leaves template and lines intact', async () => {
    const created = await createTemplate({ name: 'Rent', matchNormalizedCounterparty: 'RENT' });
    const id = created.json().id;
    await materialize('2025-08');
    expect(linesOfMonth('2025-08')).toHaveLength(1);

    const res = await app.inject({ method: 'DELETE', url: `/api/recurring-templates/${id}` });
    expect(res.statusCode).toBe(409);
    expect(res.json().hint).toMatch(/endMonth/);

    const listed = await app.inject({ method: 'GET', url: '/api/recurring-templates' });
    expect(listed.json()).toHaveLength(1);
    expect(linesOfMonth('2025-08')).toHaveLength(1);
  });

  it('criterion 15: setting endMonth stops future materialization while past months keep their lines', async () => {
    const created = await createTemplate({ name: 'Rent', matchNormalizedCounterparty: 'RENT' });
    const id = created.json().id;
    await materialize('2025-08');

    await app.inject({
      method: 'PATCH',
      url: `/api/recurring-templates/${id}`,
      payload: { endMonth: '2025-08' },
    });

    await materialize('2025-09');
    expect(linesOfMonth('2025-09')).toHaveLength(0);
    expect(linesOfMonth('2025-08')).toHaveLength(1);
  });

  it('criterion 15: DELETE succeeds for a template that never materialized a line', async () => {
    const created = await createTemplate({ name: 'Unused', matchNormalizedCounterparty: 'UNUSED' });
    const id = created.json().id;

    const res = await app.inject({ method: 'DELETE', url: `/api/recurring-templates/${id}` });
    expect(res.statusCode).toBe(204);

    const listed = await app.inject({ method: 'GET', url: '/api/recurring-templates' });
    expect(listed.json()).toHaveLength(0);
  });
});
