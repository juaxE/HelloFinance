import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  accounts,
  categories,
  imports,
  labelingRules,
  stagedTransactions,
  transactions,
} from '../db/schema';
import { computeContentHash } from './contentHash';
import { normalizeCounterparty } from './normalize';
import { sPankkiAdapter } from './spankki';

/** Thrown for pipeline-level failures the route layer maps to an HTTP status. */
export class ImportPipelineError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

type StagedRow = typeof stagedTransactions.$inferSelect;
type ImportRow = typeof imports.$inferSelect;

// --- Analyze -----------------------------------------------------------

export interface AnalyzeParams {
  accountId: number;
  filename: string;
  bytes: Uint8Array;
}

/**
 * Upload -> detect + parse -> dedup + boundary check -> propose labels ->
 * stage. Spec 002 "Import pipeline" steps 1-4.
 */
export function analyzeImport(db: Db, params: AnalyzeParams): { importId: number } {
  const [account] = db.select().from(accounts).where(eq(accounts.id, params.accountId)).all();
  if (!account) {
    throw new ImportPipelineError('account not found', 404);
  }

  const { encoding, rows } = sPankkiAdapter.parse(params.bytes);

  const [transferCategory] = db
    .select()
    .from(categories)
    .where(eq(categories.systemKey, 'transfer'))
    .all();
  const [incomeCategory] = db
    .select()
    .from(categories)
    .where(eq(categories.systemKey, 'income'))
    .all();

  const ruleRows = db.select().from(labelingRules).all();
  const ruleByNormalized = new Map(ruleRows.map((r) => [r.normalizedCounterparty, r.categoryId]));

  // Existing dedup keys: archive_id (S-Pankki, always present) or, for a
  // future bank without one, content_hash of an existing null-archive_id row
  // (CLAUDE.md non-negotiable #4 fallback).
  const parsedArchiveIds = [...new Set(rows.map((r) => r.archiveId).filter((v) => v !== null))];
  const existingByArchiveId = new Map<string, number>();
  if (parsedArchiveIds.length > 0) {
    for (const t of db
      .select({ archiveId: transactions.archiveId, accountId: transactions.accountId })
      .from(transactions)
      .where(inArray(transactions.archiveId, parsedArchiveIds))
      .all()) {
      existingByArchiveId.set(t.archiveId!, t.accountId);
    }
  }
  const existingByContentHash = new Map<string, number>();
  const nullArchiveContentHashes = rows
    .filter((r) => r.archiveId === null)
    .map((r) =>
      computeContentHash({
        accountId: params.accountId,
        paymentDate: r.paymentDate,
        amountCents: r.amountCents,
        counterparty: r.counterparty,
        reference: r.reference,
        message: r.message,
      }),
    );
  if (nullArchiveContentHashes.length > 0) {
    for (const t of db
      .select({ contentHash: transactions.contentHash, accountId: transactions.accountId })
      .from(transactions)
      .where(
        and(
          isNull(transactions.archiveId),
          inArray(transactions.contentHash, [...new Set(nullArchiveContentHashes)]),
        ),
      )
      .all()) {
      existingByContentHash.set(t.contentHash, t.accountId);
    }
  }

  const seenInBatch = new Set<string>();
  let duplicateCount = 0;

  const values = rows.map((row) => {
    const normalizedCounterparty = normalizeCounterparty(row.counterparty);
    const contentHash = computeContentHash({
      accountId: params.accountId,
      paymentDate: row.paymentDate,
      amountCents: row.amountCents,
      counterparty: row.counterparty,
      reference: row.reference,
      message: row.message,
    });

    const dedupKey = row.archiveId !== null ? `arc:${row.archiveId}` : `hash:${contentHash}`;
    const existingAccountId =
      row.archiveId !== null
        ? existingByArchiveId.get(row.archiveId)
        : existingByContentHash.get(contentHash);

    let dupState: StagedRow['dupState'];
    let duplicateAccountId: number | null = null;
    if (existingAccountId !== undefined) {
      dupState = 'duplicate_existing';
      duplicateAccountId = existingAccountId;
      duplicateCount++;
    } else if (seenInBatch.has(dedupKey)) {
      dupState = 'duplicate_in_batch';
      duplicateCount++;
    } else {
      dupState = 'new';
      seenInBatch.add(dedupKey);
    }

    const beforeOpening =
      account.openingBalanceDate !== null && row.paymentDate < account.openingBalanceDate;

    let proposedCategoryId: number | null = null;
    let proposedSource: StagedRow['proposedSource'] = null;
    if (dupState === 'new') {
      if (row.type === 'OMA TILISIIRTO' && transferCategory) {
        proposedCategoryId = transferCategory.id;
        proposedSource = 'type_hint';
      } else if (row.type === 'PALKKA' && incomeCategory) {
        proposedCategoryId = incomeCategory.id;
        proposedSource = 'type_hint';
      } else if (ruleByNormalized.has(normalizedCounterparty)) {
        proposedCategoryId = ruleByNormalized.get(normalizedCounterparty)!;
        proposedSource = 'rule';
      }
    }

    return {
      importId: 0, // filled in after the imports row is created
      paymentDate: row.paymentDate,
      bookingDate: row.bookingDate,
      amountCents: row.amountCents,
      type: row.type,
      payer: row.payer,
      payee: row.payee,
      counterparty: row.counterparty,
      normalizedCounterparty,
      counterpartyIban: row.counterpartyIban,
      counterpartyBic: row.counterpartyBic,
      reference: row.reference,
      message: row.message,
      archiveId: row.archiveId,
      contentHash,
      dupState,
      duplicateAccountId,
      beforeOpening,
      proposedCategoryId,
      proposedSource,
    };
  });

  const importRow = db
    .insert(imports)
    .values({
      bank: 's-pankki',
      accountId: params.accountId,
      filename: params.filename,
      encodingDetected: encoding,
      rowCount: rows.length,
      duplicateCount,
      status: 'pending_review',
    })
    .returning()
    .get();

  if (values.length > 0) {
    db.insert(stagedTransactions)
      .values(values.map((v) => ({ ...v, importId: importRow.id })))
      .run();
  }

  return { importId: importRow.id };
}

// --- Detail (grouped for review) ----------------------------------------

export interface StagedGroup {
  normalizedCounterparty: string;
  exampleRaw: string;
  count: number;
  totalAmountCents: number;
  fromRule: boolean;
  proposedCategoryId: number | null;
  chosenCategoryId: number | null;
  rememberRule: boolean;
  rows: Array<{
    id: number;
    paymentDate: string;
    amountCents: number;
    counterparty: string;
    note: string | null;
    proposedCategoryId: number | null;
    chosenCategoryId: number | null;
    beforeOpening: boolean;
  }>;
}

export interface DuplicateRow {
  id: number;
  paymentDate: string;
  amountCents: number;
  counterparty: string;
  dupState: 'duplicate_existing' | 'duplicate_in_batch';
  duplicateAccountId: number | null;
}

export interface ImportDetail {
  importId: number;
  status: ImportRow['status'];
  accountId: number;
  filename: string;
  encoding: ImportRow['encodingDetected'];
  counts: { total: number; new: number; duplicates: number };
  groups: StagedGroup[];
  duplicates: DuplicateRow[];
}

export function getImportDetail(db: Db, importId: number): ImportDetail {
  const [importRow] = db.select().from(imports).where(eq(imports.id, importId)).all();
  if (!importRow) {
    throw new ImportPipelineError('import not found', 404);
  }

  const staged = db
    .select()
    .from(stagedTransactions)
    .where(eq(stagedTransactions.importId, importId))
    .all();

  const newRows = staged.filter((r) => r.dupState === 'new');
  const duplicateRows = staged.filter((r) => r.dupState !== 'new');

  const groupOrder: string[] = [];
  const groupsByKey = new Map<string, StagedRow[]>();
  for (const row of newRows) {
    if (!groupsByKey.has(row.normalizedCounterparty)) {
      groupsByKey.set(row.normalizedCounterparty, []);
      groupOrder.push(row.normalizedCounterparty);
    }
    groupsByKey.get(row.normalizedCounterparty)!.push(row);
  }

  const groups: StagedGroup[] = groupOrder.map((key) => {
    const groupRows = groupsByKey.get(key)!;
    const first = groupRows[0]!;
    const chosenIds = new Set(groupRows.map((r) => r.chosenCategoryId));
    const uniformChosen = chosenIds.size === 1 ? [...chosenIds][0]! : null;
    return {
      normalizedCounterparty: key,
      exampleRaw: first.counterparty,
      count: groupRows.length,
      totalAmountCents: groupRows.reduce((sum, r) => sum + r.amountCents, 0),
      fromRule: first.proposedSource === 'rule',
      proposedCategoryId: first.proposedCategoryId,
      chosenCategoryId: uniformChosen,
      rememberRule: groupRows.every((r) => r.rememberRule),
      rows: groupRows.map((r) => ({
        id: r.id,
        paymentDate: r.paymentDate,
        amountCents: r.amountCents,
        counterparty: r.counterparty,
        note: r.note,
        proposedCategoryId: r.proposedCategoryId,
        chosenCategoryId: r.chosenCategoryId,
        beforeOpening: r.beforeOpening,
      })),
    };
  });

  const duplicates: DuplicateRow[] = duplicateRows.map((r) => ({
    id: r.id,
    paymentDate: r.paymentDate,
    amountCents: r.amountCents,
    counterparty: r.counterparty,
    dupState: r.dupState as 'duplicate_existing' | 'duplicate_in_batch',
    duplicateAccountId: r.duplicateAccountId,
  }));

  return {
    importId: importRow.id,
    status: importRow.status,
    accountId: importRow.accountId,
    filename: importRow.filename,
    encoding: importRow.encodingDetected,
    counts: {
      total: importRow.rowCount,
      new: newRows.length,
      duplicates: importRow.duplicateCount,
    },
    groups,
    duplicates,
  };
}

// --- Group / row edits ---------------------------------------------------

export function updateGroup(
  db: Db,
  importId: number,
  normalizedCounterparty: string,
  patch: { categoryId: number | null; rememberRule: boolean },
): void {
  assertPendingReview(db, importId);
  db.update(stagedTransactions)
    .set({ chosenCategoryId: patch.categoryId, rememberRule: patch.rememberRule })
    .where(
      and(
        eq(stagedTransactions.importId, importId),
        eq(stagedTransactions.normalizedCounterparty, normalizedCounterparty),
        eq(stagedTransactions.dupState, 'new'),
      ),
    )
    .run();
}

export function updateRow(
  db: Db,
  importId: number,
  rowId: number,
  patch: { categoryId?: number | null; note?: string | null },
): void {
  assertPendingReview(db, importId);
  const [row] = db
    .select()
    .from(stagedTransactions)
    .where(and(eq(stagedTransactions.id, rowId), eq(stagedTransactions.importId, importId)))
    .all();
  if (!row) {
    throw new ImportPipelineError('staged row not found', 404);
  }
  db.update(stagedTransactions)
    .set({
      ...('categoryId' in patch && { chosenCategoryId: patch.categoryId ?? null }),
      ...('note' in patch && { note: patch.note ?? null }),
    })
    .where(eq(stagedTransactions.id, rowId))
    .run();
}

function assertPendingReview(db: Db, importId: number): ImportRow {
  const [importRow] = db.select().from(imports).where(eq(imports.id, importId)).all();
  if (!importRow) {
    throw new ImportPipelineError('import not found', 404);
  }
  if (importRow.status !== 'pending_review') {
    throw new ImportPipelineError(`import is ${importRow.status}, not pending review`, 409);
  }
  return importRow;
}

// --- Commit ----------------------------------------------------------------

export interface CommitResult {
  inserted: number;
  duplicates: number;
  uncategorized: number;
}

/** Spec 002 "Commit". Idempotent: re-running on an already-committed import is a no-op. */
export function commitImport(
  db: Db,
  importId: number,
  opts: { allowUncategorized: boolean },
): CommitResult {
  const [importRow] = db.select().from(imports).where(eq(imports.id, importId)).all();
  if (!importRow) {
    throw new ImportPipelineError('import not found', 404);
  }
  if (importRow.status === 'discarded') {
    throw new ImportPipelineError('import was discarded', 409);
  }
  if (importRow.status === 'committed') {
    return computeCommittedCounts(db, importRow);
  }

  const staged = db
    .select()
    .from(stagedTransactions)
    .where(and(eq(stagedTransactions.importId, importId), eq(stagedTransactions.dupState, 'new')))
    .all();

  const eligible = staged.filter((r) => !r.beforeOpening);
  const resolved = eligible.map((row) => resolveFinalCategory(row));
  const unlabeledCount = resolved.filter((r) => r.categoryId === null).length;

  if (unlabeledCount > 0 && !opts.allowUncategorized) {
    throw new ImportPipelineError(
      'some rows are still uncategorized; pass allowUncategorized: true to commit them as Uncategorized',
      400,
    );
  }

  // Remember-rule upsert covers every group marked remember_rule=true, even if
  // some of its rows are before-opening-excluded (the rule is still learned).
  const rememberGroups = new Map<string, { categoryId: number; exampleRaw: string }>();
  for (const row of staged) {
    if (row.rememberRule) {
      const final = resolveFinalCategory(row);
      if (final.categoryId !== null) {
        rememberGroups.set(row.normalizedCounterparty, {
          categoryId: final.categoryId,
          exampleRaw: row.counterparty,
        });
      }
    }
  }

  db.transaction((tx) => {
    for (let i = 0; i < eligible.length; i++) {
      const row = eligible[i]!;
      const final = resolved[i]!;
      tx.insert(transactions)
        .values({
          accountId: importRow.accountId,
          paymentDate: row.paymentDate,
          bookingDate: row.bookingDate,
          amountCents: row.amountCents,
          type: row.type,
          payer: row.payer,
          payee: row.payee,
          counterparty: row.counterparty,
          counterpartyIban: row.counterpartyIban,
          counterpartyBic: row.counterpartyBic,
          reference: row.reference,
          message: row.message,
          archiveId: row.archiveId,
          contentHash: row.contentHash,
          categoryId: final.categoryId,
          categorySource: final.source,
          note: row.note,
          importId,
        })
        .run();
    }

    for (const [normalizedCounterparty, rule] of rememberGroups) {
      tx.insert(labelingRules)
        .values({
          normalizedCounterparty,
          categoryId: rule.categoryId,
          exampleRaw: rule.exampleRaw,
        })
        .onConflictDoUpdate({
          target: labelingRules.normalizedCounterparty,
          set: { categoryId: rule.categoryId, exampleRaw: rule.exampleRaw, updatedAt: new Date() },
        })
        .run();
    }

    tx.update(imports)
      .set({ insertedCount: eligible.length, status: 'committed' })
      .where(eq(imports.id, importId))
      .run();
    tx.delete(stagedTransactions).where(eq(stagedTransactions.importId, importId)).run();
  });

  return {
    inserted: eligible.length,
    duplicates: importRow.duplicateCount,
    uncategorized: unlabeledCount,
  };
}

function resolveFinalCategory(row: StagedRow): {
  categoryId: number | null;
  source: 'manual' | 'rule' | 'type_hint' | null;
} {
  if (row.chosenCategoryId !== null) {
    return { categoryId: row.chosenCategoryId, source: 'manual' };
  }
  if (row.proposedCategoryId !== null) {
    return { categoryId: row.proposedCategoryId, source: row.proposedSource };
  }
  return { categoryId: null, source: null };
}

function computeCommittedCounts(db: Db, importRow: ImportRow): CommitResult {
  const committed = db
    .select()
    .from(transactions)
    .where(eq(transactions.importId, importRow.id))
    .all();
  return {
    inserted: committed.length,
    duplicates: importRow.duplicateCount,
    uncategorized: committed.filter((t) => t.categoryId === null).length,
  };
}

// --- Discard -----------------------------------------------------------

export function discardImport(db: Db, importId: number): void {
  const importRow = assertPendingReview(db, importId);
  db.transaction((tx) => {
    tx.delete(stagedTransactions).where(eq(stagedTransactions.importId, importId)).run();
    tx.update(imports).set({ status: 'discarded' }).where(eq(imports.id, importRow.id)).run();
  });
}

// --- Extend history (decision 002-E) --------------------------------------

export interface ExtendHistoryResult {
  openingBalanceDate: string;
  openingBalanceCents: number;
  extendedRowCount: number;
}

/**
 * Rows dated before the account's opening balance are excluded at commit
 * (decision 001-A). This one-click assist lowers opening_balance_date to the
 * earliest excluded row and recomputes opening_balance_cents so recent
 * balances are unchanged (decision 002-E), then re-analyzes the staged rows
 * in place so they fall in-window.
 */
export function extendHistory(db: Db, importId: number): ExtendHistoryResult {
  assertPendingReview(db, importId);

  const excluded = db
    .select()
    .from(stagedTransactions)
    .where(
      and(
        eq(stagedTransactions.importId, importId),
        eq(stagedTransactions.dupState, 'new'),
        eq(stagedTransactions.beforeOpening, true),
      ),
    )
    .all();

  if (excluded.length === 0) {
    throw new ImportPipelineError('no before-opening rows to extend', 400);
  }

  const [importRow] = db.select().from(imports).where(eq(imports.id, importId)).all();
  const [account] = db.select().from(accounts).where(eq(accounts.id, importRow!.accountId)).all();

  const earliestDate = excluded.reduce(
    (min, r) => (r.paymentDate < min ? r.paymentDate : min),
    excluded[0]!.paymentDate,
  );
  const excludedSum = excluded.reduce((sum, r) => sum + r.amountCents, 0);
  const newOpeningCents = account!.openingBalanceCents - excludedSum;

  db.transaction((tx) => {
    tx.update(accounts)
      .set({ openingBalanceDate: earliestDate, openingBalanceCents: newOpeningCents })
      .where(eq(accounts.id, account!.id))
      .run();

    // Re-analyze in place: recompute before_opening for every staged 'new' row
    // of this import against the new opening date.
    const allNew = tx
      .select()
      .from(stagedTransactions)
      .where(and(eq(stagedTransactions.importId, importId), eq(stagedTransactions.dupState, 'new')))
      .all();
    for (const row of allNew) {
      const beforeOpening = row.paymentDate < earliestDate;
      if (beforeOpening !== row.beforeOpening) {
        tx.update(stagedTransactions)
          .set({ beforeOpening })
          .where(eq(stagedTransactions.id, row.id))
          .run();
      }
    }
  });

  return {
    openingBalanceDate: earliestDate,
    openingBalanceCents: newOpeningCents,
    extendedRowCount: excluded.length,
  };
}
