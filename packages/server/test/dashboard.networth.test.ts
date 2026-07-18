/**
 * Spec 004 stage 2 — assets, snapshots and net worth.
 *
 * Criteria covered here: 3, 4, 8, 9.
 *
 * Criteria 3, 4 and 8 run over the seeded fixture state and assert against
 * `fixtures/expected.json`, whose `netWorth.byMonth` is computed by the fixture
 * generator from the SAME account rows and asset snapshots the seed loads.
 * Criterion 9 needs accounts with different opening dates, so it builds its own.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { Asset, AssetSnapshotEntry, NetWorthPoint } from '@finance/shared';
import { buildApp } from '../src/app';
import type { Db } from '../src/db/client';
import { accounts, assetSnapshots, assets, transactions } from '../src/db/schema';
import { createTestDb, EXPECTED, FIXTURE_MONTHS, seedFixtureApp } from './helpers';

let app: FastifyInstance;
let db: Db;

const NOW = new Date('2026-06-15T12:00:00.000Z');

beforeEach(async () => {
  db = createTestDb();
  app = buildApp(db, { now: () => NOW });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function get<T>(url: string): Promise<T> {
  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode, `${url} -> ${res.body}`).toBe(200);
  return res.json() as T;
}

/** The full available window — what criterion 8's wholesale comparison needs. */
const FULL_WINDOW = '/api/dashboard/net-worth?from=2025-07&to=2026-06';

function assetByName(name: string): typeof assets.$inferSelect {
  const row = db.select().from(assets).all().find((a) => a.name === name);
  if (!row) throw new Error(`asset ${name} not found`);
  return row;
}

describe('spec 004 — net worth over the seeded fixtures', () => {
  beforeEach(() => {
    seedFixtureApp(db);
  });

  it('criterion 3: net worth equals opening balances + summed transactions + snapshots − loans', async () => {
    const points = await get<NetWorthPoint[]>(FULL_WINDOW);
    expect(points.map((p) => p.month)).toEqual(FIXTURE_MONTHS);

    for (const point of points) {
      const want = EXPECTED.netWorth.byMonth[point.month]!;
      expect([point.month, point.accountsCents]).toEqual([point.month, want.accountsCents]);
      expect([point.month, point.investmentsCents]).toEqual([point.month, want.investmentsCents]);
      expect([point.month, point.loansCents]).toEqual([point.month, want.loansCents]);
      expect([point.month, point.netWorthCents]).toEqual([point.month, want.netWorthCents]);
      // Loans subtract; the formula is not just a sum of parts.
      expect(point.netWorthCents).toBe(
        point.accountsCents + point.investmentsCents - point.loansCents,
      );
    }

    // The account term is the 001-A derived balance, not a stored figure: both
    // seeded accounts open at 0 on 2025-07-01, so the final month's accounts
    // total is the sum of every committed row UP TO THAT MONTH END. The bound
    // is load-bearing — the buffer fixture carries a 2026-07 row, which must not
    // appear in June's balance.
    const all = db.select().from(transactions).all();
    const throughJune = all.filter((t) => t.paymentDate <= '2026-06-30');
    expect(throughJune.length).toBeLessThan(all.length);
    expect(points.at(-1)!.accountsCents).toBe(
      throughJune.reduce((s, t) => s + t.amountCents, 0),
    );
  });

  it('criterion 3: adding a later loan snapshot decreases net worth by the loan amount', async () => {
    const before = await get<NetWorthPoint[]>(FULL_WINDOW);
    const loan = assetByName('Car loan');

    // Raise the loan balance in 2026-05 by a known amount.
    const may = db
      .select()
      .from(assetSnapshots)
      .all()
      .find((s) => s.assetId === loan.id && s.month === '2026-05')!;
    const increase = 250000;
    const res = await app.inject({
      method: 'PUT',
      url: '/api/asset-snapshots',
      payload: {
        month: '2026-05',
        values: [{ assetId: loan.id, valueCents: may.valueCents + increase }],
      },
    });
    expect(res.statusCode).toBe(200);

    const after = await get<NetWorthPoint[]>(FULL_WINDOW);
    for (const point of after) {
      const previous = before.find((p) => p.month === point.month)!;
      // 2026-05 moves by the increase; 2026-06 has its own snapshot, so it does
      // not inherit the change; earlier months are untouched.
      const expectedDelta = point.month === '2026-05' ? -increase : 0;
      expect([point.month, point.netWorthCents - previous.netWorthCents]).toEqual([
        point.month,
        expectedDelta,
      ]);
    }
  });

  it('criterion 4: a month with no new snapshot carries the most recent prior one forward, per asset', async () => {
    const investment = EXPECTED.assets.seeded.find((a) => a.kind === 'investment')!;
    const loan = EXPECTED.assets.seeded.find((a) => a.kind === 'loan')!;
    // The fixtures deliberately skip a month in each series.
    expect(investment.snapshots[investment.gapMonth]).toBeUndefined();
    expect(loan.snapshots[loan.gapMonth]).toBeUndefined();

    const points = await get<NetWorthPoint[]>(FULL_WINDOW);
    const previousMonthOf = (month: string): string =>
      FIXTURE_MONTHS[FIXTURE_MONTHS.indexOf(month) - 1]!;

    // The gap month reuses the previous month's value — it does NOT drop to zero,
    // and the other asset keeps moving normally in that same month.
    const investmentGap = points.find((p) => p.month === investment.gapMonth)!;
    const beforeInvestmentGap = points.find(
      (p) => p.month === previousMonthOf(investment.gapMonth),
    )!;
    expect(investmentGap.investmentsCents).toBe(beforeInvestmentGap.investmentsCents);
    expect(investmentGap.investmentsCents).not.toBe(0);
    expect(investmentGap.loansCents).not.toBe(beforeInvestmentGap.loansCents);

    const loanGap = points.find((p) => p.month === loan.gapMonth)!;
    const beforeLoanGap = points.find((p) => p.month === previousMonthOf(loan.gapMonth))!;
    expect(loanGap.loansCents).toBe(beforeLoanGap.loansCents);
    expect(loanGap.loansCents).not.toBe(0);

    // The entry form pre-fills the carried value and says so.
    const entries = await get<AssetSnapshotEntry[]>(
      `/api/asset-snapshots?month=${investment.gapMonth}`,
    );
    const entry = entries.find((e) => e.name === investment.name)!;
    expect(entry.carriedForward).toBe(true);
    expect(entry.sourceMonth).toBe(previousMonthOf(investment.gapMonth));
    expect(entry.valueCents).toBe(beforeInvestmentGap.investmentsCents);
  });

  it('criterion 8: archiving an asset leaves every net-worth month byte-identical, hides it from the form, and 400s on PUT', async () => {
    // Capture the ENTIRE window before archiving. A spot check of a month or two
    // would pick the wrong months about as often as the right ones: the
    // regression this guards against — excluding archived assets from the
    // net-worth query — shifts every month from the asset's first snapshot on.
    const baseline = await get<NetWorthPoint[]>(FULL_WINDOW);
    const loan = assetByName('Car loan');
    const lastSnapshot = db
      .select()
      .from(assetSnapshots)
      .all()
      .filter((s) => s.assetId === loan.id)
      .sort((a, b) => a.month.localeCompare(b.month))
      .at(-1)!;
    expect(lastSnapshot.valueCents).not.toBe(0); // a non-zero last value

    const archived = await app.inject({
      method: 'PATCH',
      url: `/api/assets/${loan.id}`,
      payload: { archived: true },
    });
    expect(archived.statusCode).toBe(200);
    expect((archived.json() as Asset).archivedAt).not.toBeNull();

    // Wholesale deep-equal, past and future alike.
    expect(await get<NetWorthPoint[]>(FULL_WINDOW)).toEqual(baseline);

    // ...gone from the entry form,
    const entries = await get<AssetSnapshotEntry[]>('/api/asset-snapshots?month=2026-06');
    expect(entries.some((e) => e.assetId === loan.id)).toBe(false);
    expect(entries.some((e) => e.name === 'Index fund')).toBe(true);

    // ...and PUT on it is rejected, with its snapshots left intact.
    const rejected = await app.inject({
      method: 'PUT',
      url: '/api/asset-snapshots',
      payload: { month: '2026-06', values: [{ assetId: loan.id, valueCents: 0 }] },
    });
    expect(rejected.statusCode).toBe(400);
    expect(db.select().from(assetSnapshots).all().filter((s) => s.assetId === loan.id).length).toBe(
      Object.keys(EXPECTED.assets.seeded.find((a) => a.kind === 'loan')!.snapshots).length,
    );
    expect(await get<NetWorthPoint[]>(FULL_WINDOW)).toEqual(baseline);
  });

  it('criterion 8: the intended flow — a closing 0 snapshot before archiving raises net worth from that month on, leaving earlier months unchanged', async () => {
    const loan = assetByName('Car loan');
    const settledMonth = '2026-04';

    // The loan is settled in April, so the owner entered no values after it.
    // (The fixture series runs to June; without this the later months would keep
    // reporting their own snapshots and "from M onward" would be untestable.)
    for (const stale of db
      .select()
      .from(assetSnapshots)
      .all()
      .filter((s) => s.assetId === loan.id && s.month > settledMonth)) {
      db.delete(assetSnapshots).where(eq(assetSnapshots.id, stale.id)).run();
    }

    const baseline = await get<NetWorthPoint[]>(FULL_WINDOW);
    const balanceAtSettlement = baseline.find((p) => p.month === settledMonth)!.loansCents;
    expect(balanceAtSettlement).toBeGreaterThan(0);

    // Enter the final 0 FIRST, then archive — the ordering 004-F enforces.
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/asset-snapshots',
      payload: { month: settledMonth, values: [{ assetId: loan.id, valueCents: 0 }] },
    });
    expect(saved.statusCode).toBe(200);
    const archived = await app.inject({
      method: 'PATCH',
      url: `/api/assets/${loan.id}`,
      payload: { archived: true },
    });
    expect(archived.statusCode).toBe(200);

    const after = await get<NetWorthPoint[]>(FULL_WINDOW);
    for (const point of after) {
      const previous = baseline.find((p) => p.month === point.month)!;
      if (point.month < settledMonth) {
        // Months before M deep-equal the captured baseline.
        expect(point).toEqual(previous);
        continue;
      }
      // From M onward the loan is gone: net worth rises by that month's balance,
      // which for later months is their own (later, smaller) snapshot value.
      expect([point.month, point.loansCents]).toEqual([point.month, 0]);
      expect([point.month, point.netWorthCents]).toEqual([
        point.month,
        previous.netWorthCents + previous.loansCents,
      ]);
    }
    // The settled month specifically rose by the balance that was outstanding.
    expect(after.find((p) => p.month === settledMonth)!.netWorthCents).toBe(
      baseline.find((p) => p.month === settledMonth)!.netWorthCents + balanceAtSettlement,
    );
  });

  it('criterion 8: snapshot PUT is a partial upsert — omitted assets are untouched', async () => {
    const before = await get<AssetSnapshotEntry[]>('/api/asset-snapshots?month=2026-06');
    const investment = assetByName('Index fund');
    const loanEntryBefore = before.find((e) => e.name === 'Car loan')!;

    await app.inject({
      method: 'PUT',
      url: '/api/asset-snapshots',
      payload: { month: '2026-06', values: [{ assetId: investment.id, valueCents: 9_999_00 }] },
    });

    const after = await get<AssetSnapshotEntry[]>('/api/asset-snapshots?month=2026-06');
    expect(after.find((e) => e.assetId === investment.id)!.valueCents).toBe(9_999_00);
    // The omitted loan kept its own snapshot — no delete-by-omission, no zeroing.
    expect(after.find((e) => e.name === 'Car loan')).toEqual(loanEntryBefore);
  });
});

describe('spec 004 — months before an account existed (004-E)', () => {
  /**
   * Criterion 9. The bug this guards against renders the opening balance as a
   * flat line backwards in time, which looks entirely correct — so the zero
   * contribution is asserted explicitly, not inferred from a total.
   */
  it('criterion 9: the trend clamps to the earliest opening month, and a not-yet-open account contributes 0 with partialAccounts set', async () => {
    const early = db
      .insert(accounts)
      .values({
        name: 'Early',
        kind: 'main',
        openingBalanceDate: '2026-01-01',
        openingBalanceCents: 500000,
      })
      .returning()
      .get();
    const late = db
      .insert(accounts)
      .values({
        name: 'Late',
        kind: 'savings',
        openingBalanceDate: '2026-03-01',
        openingBalanceCents: 200000,
      })
      .returning()
      .get();
    db.insert(transactions)
      .values({
        accountId: late.id,
        paymentDate: '2026-03-10',
        bookingDate: '2026-03-10',
        amountCents: 10000,
        type: 'KORTTIOSTO',
        counterparty: 'TEST',
        contentHash: 'hash-late-1',
      })
      .run();

    // A 12-month window would reach back to 2025-07; it must be clamped to the
    // earliest opening month (2026-01) and simply return fewer points.
    const points = await get<NetWorthPoint[]>('/api/dashboard/net-worth?window=12');
    expect(points.map((p) => p.month)).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
    ]);
    expect(points.every((p) => p.month >= '2026-01')).toBe(true);

    // Months before the LATE account opens: it contributes 0, not its 200000
    // opening balance, and the month is flagged partial.
    for (const month of ['2026-01', '2026-02']) {
      const point = points.find((p) => p.month === month)!;
      expect([month, point.accountsCents]).toEqual([month, early.openingBalanceCents]);
      expect([month, point.partialAccounts]).toEqual([month, true]);
      // Asserted explicitly: the late account's own contribution is zero.
      expect([month, point.accountsCents - early.openingBalanceCents]).toEqual([month, 0]);
    }

    // From its opening month on, it contributes normally and the flag clears.
    const march = points.find((p) => p.month === '2026-03')!;
    expect(march.accountsCents).toBe(
      early.openingBalanceCents + late.openingBalanceCents + 10000,
    );
    expect(march.partialAccounts).toBe(false);
    expect(points.filter((p) => p.month >= '2026-03').every((p) => !p.partialAccounts)).toBe(true);
  });

  it('criterion 9: an explicit from/to reaching before the earliest opening date returns fewer points, not padded ones', async () => {
    db.insert(accounts)
      .values({
        name: 'Only',
        kind: 'main',
        openingBalanceDate: '2026-04-15',
        openingBalanceCents: 100000,
      })
      .run();

    const points = await get<NetWorthPoint[]>('/api/dashboard/net-worth?from=2025-01&to=2026-06');
    expect(points.map((p) => p.month)).toEqual(['2026-04', '2026-05', '2026-06']);
    // April's month end (2026-04-30) is after the opening date, so the account
    // is open and contributes its balance.
    expect(points[0]!.accountsCents).toBe(100000);
    expect(points[0]!.partialAccounts).toBe(false);
  });

  it('criterion 9: an account with a null opening date has no lower bound, so nothing is clamped', async () => {
    db.insert(accounts).values({ name: 'Unbounded', kind: 'main', openingBalanceCents: 0 }).run();

    const points = await get<NetWorthPoint[]>('/api/dashboard/net-worth?window=3');
    expect(points.map((p) => p.month)).toEqual(['2026-04', '2026-05', '2026-06']);
    expect(points.every((p) => !p.partialAccounts)).toBe(true);
  });
});
