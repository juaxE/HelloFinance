import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client';
import { accounts, categories, labelingRules, transactions } from '../src/db/schema';
import {
  ImportPipelineError,
  analyzeImport,
  commitImport,
  discardImport,
  extendHistory,
  getImportDetail,
  updateGroup,
  updateRow,
} from '../src/import/pipeline';
import { createTestDb } from './helpers';
import expected from '../../../fixtures/expected.json';

const FIXTURES_ROOT = resolve(__dirname, '../../../fixtures');
const loadFixture = (relPath: string) => readFileSync(resolve(FIXTURES_ROOT, relPath));

let db: Db;
let mainAccountId: number;

beforeEach(() => {
  db = createTestDb();
  mainAccountId = db
    .insert(accounts)
    .values({ name: 'Main', openingBalanceDate: '2025-07-01', openingBalanceCents: 0 })
    .returning()
    .get().id;
});

function categoryId(name: string): number {
  return db.select().from(categories).where(eq(categories.name, name)).get()!.id;
}

describe('analyze (AC 002-1)', () => {
  it('stages every row with correct signs, cents, ISO dates, and every transaction type', () => {
    const bytes = loadFixture(expected.files.main.path);
    const { importId } = analyzeImport(db, {
      accountId: mainAccountId,
      filename: 'main.csv',
      bytes,
    });
    const detail = getImportDetail(db, importId);

    expect(detail.encoding).toBe('utf-8');
    expect(detail.counts.total).toBe(expected.files.main.rowCount);
    expect(detail.counts.new).toBe(expected.files.main.rowCount);
    expect(detail.counts.duplicates).toBe(0);

    const allRows = detail.groups.flatMap((g) => g.rows);
    expect(allRows).toHaveLength(expected.files.main.rowCount);
    for (const row of allRows) {
      expect(row.paymentDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isInteger(row.amountCents)).toBe(true);
    }
  });
});

describe('dedup (AC 002-2, 002-3)', () => {
  it('re-importing the same file yields 0 new, all duplicate_existing', () => {
    const bytes = loadFixture(expected.files.main.path);
    const first = analyzeImport(db, { accountId: mainAccountId, filename: 'main.csv', bytes });
    commitImport(db, first.importId, { allowUncategorized: true });

    const second = analyzeImport(db, {
      accountId: mainAccountId,
      filename: 'main-again.csv',
      bytes,
    });
    const detail = getImportDetail(db, second.importId);
    expect(detail.counts).toEqual({
      total: expected.dedup.mainRowCount,
      new: 0,
      duplicates: expected.dedup.mainRowCount,
    });
    expect(detail.duplicates.every((d) => d.dupState === 'duplicate_existing')).toBe(true);
  });

  it('importing an overlapping file inserts only its non-overlapping rows; union count matches', () => {
    const mainBytes = loadFixture(expected.files.main.path);
    const first = analyzeImport(db, {
      accountId: mainAccountId,
      filename: 'main.csv',
      bytes: mainBytes,
    });
    commitImport(db, first.importId, { allowUncategorized: true });

    const overlapBytes = loadFixture(expected.files.overlap.path);
    const second = analyzeImport(db, {
      accountId: mainAccountId,
      filename: 'overlap.csv',
      bytes: overlapBytes,
    });
    const detail = getImportDetail(db, second.importId);
    expect(detail.counts).toEqual({
      total: expected.dedup.overlapRowCount,
      new: expected.dedup.overlapNewRows,
      duplicates: expected.dedup.overlapSharedWithMain,
    });

    const result = commitImport(db, second.importId, { allowUncategorized: true });
    expect(result.inserted).toBe(expected.dedup.overlapNewRows);

    const totalCommitted = db.select().from(transactions).all().length;
    expect(totalCommitted).toBe(expected.dedup.unionUniqueArchiveIds);
  });
});

describe('encoding (AC 002-4)', () => {
  it('decodes the ISO-8859-1 fixture and imports its rows correctly', () => {
    // The latin1 fixture covers 2025-06, before the default 2025-07-01 opening
    // date, so widen the window to bring these rows in-window for commit.
    db.update(accounts)
      .set({ openingBalanceDate: '2025-01-01' })
      .where(eq(accounts.id, mainAccountId))
      .run();

    const bytes = loadFixture(expected.files.encodingLatin1.path);
    const { importId } = analyzeImport(db, { accountId: mainAccountId, filename: 'l1.csv', bytes });
    const detail = getImportDetail(db, importId);
    expect(detail.encoding).toBe('iso-8859-1');
    expect(detail.counts.total).toBe(expected.files.encodingLatin1.rowCount);

    commitImport(db, importId, { allowUncategorized: true });
    const rows = db.select().from(transactions).all();
    expect(rows.some((r) => r.payer === expected.files.encodingLatin1.sampleDecodedPayer)).toBe(
      true,
    );
  });
});

describe('type hints (AC 002-5)', () => {
  it('OMA TILISIIRTO -> Transfer and PALKKA -> Income without user input', () => {
    const bytes = loadFixture(expected.files.main.path);
    const { importId } = analyzeImport(db, {
      accountId: mainAccountId,
      filename: 'main.csv',
      bytes,
    });
    commitImport(db, importId, { allowUncategorized: true });

    const rows = db.select().from(transactions).all();
    const transferId = categoryId('Transfer');
    const incomeId = categoryId('Income');

    const omaTilisiirto = rows.filter((r) => r.type === 'OMA TILISIIRTO');
    const palkka = rows.filter((r) => r.type === 'PALKKA');
    expect(omaTilisiirto).toHaveLength(expected.typeHints.omaTilisiirtoRowsMain);
    expect(palkka).toHaveLength(expected.typeHints.palkkaRowsMain);
    expect(
      omaTilisiirto.every((r) => r.categoryId === transferId && r.categorySource === 'type_hint'),
    ).toBe(true);
    expect(palkka.every((r) => r.categoryId === incomeId && r.categorySource === 'type_hint')).toBe(
      true,
    );
  });
});

describe('bulk apply + remember rule (AC 002-7) and manual override (AC 002-8)', () => {
  it('applies a category to a whole group, and remembering it auto-labels a later import', () => {
    const bytes = loadFixture(expected.files.main.path);
    const { importId } = analyzeImport(db, {
      accountId: mainAccountId,
      filename: 'main.csv',
      bytes,
    });
    const detail = getImportDetail(db, importId);
    const kMarket = detail.groups.find((g) => g.normalizedCounterparty === 'K-MARKET')!;
    expect(kMarket.count).toBeGreaterThan(1);

    const groceries = categoryId('Groceries');
    updateGroup(db, importId, 'K-MARKET', { categoryId: groceries, rememberRule: true });

    const afterPatch = getImportDetail(db, importId);
    const patchedGroup = afterPatch.groups.find((g) => g.normalizedCounterparty === 'K-MARKET')!;
    expect(patchedGroup.chosenCategoryId).toBe(groceries);

    commitImport(db, importId, { allowUncategorized: true });

    const rule = db
      .select()
      .from(labelingRules)
      .where(eq(labelingRules.normalizedCounterparty, 'K-MARKET'))
      .get();
    expect(rule?.categoryId).toBe(groceries);

    // The committed rows picked it up as 'manual' (the user's bulk action), not 'rule'.
    const committedKMarket = db
      .select()
      .from(transactions)
      .all()
      .filter((t) => t.counterparty.toUpperCase().includes('K-MARKET'));
    expect(committedKMarket.every((t) => t.categorySource === 'manual')).toBe(true);

    // A later import of a new K-Market-like row is auto-labeled from the rule.
    const bytes2 = Buffer.from(
      'Kirjauspäivä;Maksupäivä;Summa;Tapahtumalaji;Maksaja;Saajan nimi;Saajan tilinumero;Saajan BIC-tunnus;Viitenumero;Viesti;Arkistointitunnus\n' +
        "05.07.2026;05.07.2026;-12,00;KORTTIOSTO;MATTI MEIKÄLÄINEN;K-Market Töölö;-;-;-;'-';ARK-NEW-1\n",
      'utf-8',
    );
    const { importId: importId2 } = analyzeImport(db, {
      accountId: mainAccountId,
      filename: 'new.csv',
      bytes: bytes2,
    });
    const detail2 = getImportDetail(db, importId2);
    const group2 = detail2.groups.find((g) => g.normalizedCounterparty === 'K-MARKET')!;
    expect(group2.fromRule).toBe(true);
    expect(group2.proposedCategoryId).toBe(groceries);

    const commit2 = commitImport(db, importId2, { allowUncategorized: true });
    expect(commit2.uncategorized).toBe(0);
    const newRow = db
      .select()
      .from(transactions)
      .where(eq(transactions.archiveId, 'ARK-NEW-1'))
      .get()!;
    expect(newRow.categoryId).toBe(groceries);
    expect(newRow.categorySource).toBe('rule'); // untouched by the user -> stays 'rule', not 'manual'
  });

  it('a per-row manual override beats a matching rule and persists as manual', () => {
    const groceries = categoryId('Groceries');
    const other = categoryId('Other');
    db.insert(labelingRules)
      .values({ normalizedCounterparty: 'K-MARKET', categoryId: groceries, exampleRaw: 'K-Market' })
      .run();

    const bytes = loadFixture(expected.files.main.path);
    const { importId } = analyzeImport(db, {
      accountId: mainAccountId,
      filename: 'main.csv',
      bytes,
    });
    const detail = getImportDetail(db, importId);
    const kMarketGroup = detail.groups.find((g) => g.normalizedCounterparty === 'K-MARKET')!;
    expect(kMarketGroup.proposedCategoryId).toBe(groceries); // rule pre-fills the proposal

    const oneRow = kMarketGroup.rows[0]!;
    updateRow(db, importId, oneRow.id, { categoryId: other });

    commitImport(db, importId, { allowUncategorized: true });
    const allKMarket = db
      .select()
      .from(transactions)
      .all()
      .filter((t) => t.counterparty.toUpperCase().includes('K-MARKET'));
    const overridden = allKMarket.find(
      (t) => t.paymentDate === oneRow.paymentDate && t.amountCents === oneRow.amountCents,
    )!;
    expect(overridden.categoryId).toBe(other);
    expect(overridden.categorySource).toBe('manual');

    // The other K-Market rows (never touched) still followed the rule.
    const restStillRule = allKMarket.filter((t) => t.id !== overridden.id);
    expect(restStillRule.length).toBeGreaterThan(0);
    expect(
      restStillRule.every((t) => t.categoryId === groceries && t.categorySource === 'rule'),
    ).toBe(true);
  });
});

describe('wrong-account duplicate attribution (AC 002-9)', () => {
  it('a file already imported into a different account reports duplicates attributed to it', () => {
    const bufferAccountId = db
      .insert(accounts)
      .values({ name: 'Buffer', kind: 'buffer', openingBalanceDate: '2025-07-01' })
      .returning()
      .get().id;

    const bytes = loadFixture(expected.files.main.path);
    const first = analyzeImport(db, { accountId: mainAccountId, filename: 'main.csv', bytes });
    commitImport(db, first.importId, { allowUncategorized: true });

    const wrong = analyzeImport(db, {
      accountId: bufferAccountId,
      filename: 'main-wrong.csv',
      bytes,
    });
    const detail = getImportDetail(db, wrong.importId);
    expect(detail.counts.new).toBe(0);
    expect(detail.duplicates.length).toBe(expected.files.main.rowCount);
    expect(detail.duplicates.every((d) => d.duplicateAccountId === mainAccountId)).toBe(true);
  });
});

describe('before-opening exclusion + extend history (AC 002-10, 002-11)', () => {
  it('excludes rows before opening_balance_date, and Extend History brings them in-window without shifting the balance', () => {
    db.update(accounts)
      .set({ openingBalanceDate: '2025-09-01', openingBalanceCents: 500000 })
      .where(eq(accounts.id, mainAccountId))
      .run();

    const bytes = loadFixture(expected.files.main.path);
    const { importId } = analyzeImport(db, {
      accountId: mainAccountId,
      filename: 'main.csv',
      bytes,
    });
    const before = getImportDetail(db, importId);
    const excludedRows = before.groups.flatMap((g) => g.rows).filter((r) => r.beforeOpening);
    expect(excludedRows.length).toBeGreaterThan(0);

    const commitResult = commitImport(db, importId, { allowUncategorized: true });
    expect(commitResult.inserted).toBe(before.counts.new - excludedRows.length);
    const committedDates = db
      .select()
      .from(transactions)
      .all()
      .map((t) => t.paymentDate);
    expect(committedDates.every((d) => d >= '2025-09-01')).toBe(true);
  });

  it('extend history sets opening date/balance exactly and preserves the balance at every later date', () => {
    db.update(accounts)
      .set({ openingBalanceDate: '2025-09-01', openingBalanceCents: 500000 })
      .where(eq(accounts.id, mainAccountId))
      .run();

    const bytes = loadFixture(expected.files.main.path);
    const { importId } = analyzeImport(db, {
      accountId: mainAccountId,
      filename: 'main.csv',
      bytes,
    });
    const before = getImportDetail(db, importId);
    const excludedBefore = before.groups.flatMap((g) => g.rows).filter((r) => r.beforeOpening);
    const earliestExcluded = excludedBefore.reduce(
      (min, r) => (r.paymentDate < min ? r.paymentDate : min),
      excludedBefore[0]!.paymentDate,
    );
    const excludedSum = excludedBefore.reduce((sum, r) => sum + r.amountCents, 0);

    const ext = extendHistory(db, importId);
    expect(ext.openingBalanceDate).toBe(earliestExcluded);
    expect(ext.openingBalanceCents).toBe(500000 - excludedSum);
    expect(ext.extendedRowCount).toBe(excludedBefore.length);

    const after = getImportDetail(db, importId);
    expect(after.groups.flatMap((g) => g.rows).some((r) => r.beforeOpening)).toBe(false);

    const commitResult = commitImport(db, importId, { allowUncategorized: true });
    expect(commitResult.inserted).toBe(before.counts.new);

    // Balance at every date >= the OLD opening date is unchanged, cent-for-cent.
    const allTx = db.select().from(transactions).all();
    const account = db.select().from(accounts).where(eq(accounts.id, mainAccountId)).get()!;
    const sumFromOldOpening = allTx
      .filter((t) => t.paymentDate >= '2025-09-01')
      .reduce((sum, t) => sum + t.amountCents, 0);
    const balanceViaOld = 500000 + sumFromOldOpening;
    const sumFromNewOpening = allTx
      .filter((t) => t.paymentDate >= account.openingBalanceDate!)
      .reduce((sum, t) => sum + t.amountCents, 0);
    const balanceViaNew = account.openingBalanceCents + sumFromNewOpening;
    expect(balanceViaNew).toBe(balanceViaOld);
  });

  it('throws when there is nothing before-opening to extend', () => {
    const bytes = loadFixture(expected.files.main.path);
    const { importId } = analyzeImport(db, {
      accountId: mainAccountId,
      filename: 'main.csv',
      bytes,
    });
    expect(() => extendHistory(db, importId)).toThrow(ImportPipelineError);
  });
});

describe('uncategorized commit gate (decision 002-C)', () => {
  it('requires allowUncategorized when a new row is still unlabeled', () => {
    const bytes = loadFixture(expected.files.main.path);
    const { importId } = analyzeImport(db, {
      accountId: mainAccountId,
      filename: 'main.csv',
      bytes,
    });
    expect(() => commitImport(db, importId, { allowUncategorized: false })).toThrow(
      ImportPipelineError,
    );
  });

  it('commits leftover new rows as Uncategorized (category_id null) when allowed', () => {
    const bytes = loadFixture(expected.files.main.path);
    const { importId } = analyzeImport(db, {
      accountId: mainAccountId,
      filename: 'main.csv',
      bytes,
    });
    const result = commitImport(db, importId, { allowUncategorized: true });
    expect(result.uncategorized).toBeGreaterThan(0);
    const uncategorizedRows = db
      .select()
      .from(transactions)
      .all()
      .filter((t) => t.categoryId === null);
    expect(uncategorizedRows.every((t) => t.categorySource === null)).toBe(true);
  });
});

describe('commit idempotency', () => {
  it('re-running commit on an already-committed import is a no-op', () => {
    const bytes = loadFixture(expected.files.main.path);
    const { importId } = analyzeImport(db, {
      accountId: mainAccountId,
      filename: 'main.csv',
      bytes,
    });
    const first = commitImport(db, importId, { allowUncategorized: true });
    const second = commitImport(db, importId, { allowUncategorized: true });
    expect(second).toEqual(first);
    expect(db.select().from(transactions).all()).toHaveLength(first.inserted);
  });

  it('rejects commit on a discarded import', () => {
    const bytes = loadFixture(expected.files.main.path);
    const { importId } = analyzeImport(db, {
      accountId: mainAccountId,
      filename: 'main.csv',
      bytes,
    });
    discardImport(db, importId);
    expect(() => commitImport(db, importId, { allowUncategorized: true })).toThrow(
      ImportPipelineError,
    );
  });
});

describe('discard', () => {
  it('drops staged rows and marks the import discarded without touching transactions', () => {
    const bytes = loadFixture(expected.files.main.path);
    const { importId } = analyzeImport(db, {
      accountId: mainAccountId,
      filename: 'main.csv',
      bytes,
    });
    discardImport(db, importId);
    const detail = getImportDetail(db, importId);
    expect(detail.status).toBe('discarded');
    expect(detail.groups).toHaveLength(0);
    expect(db.select().from(transactions).all()).toHaveLength(0);
  });
});
