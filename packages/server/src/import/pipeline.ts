import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
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

/** The transaction handle `db.transaction` hands its callback. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// --- Dedup lookup (shared by analyze and commit) -------------------------

/** Everything the dedup lookup needs from a parsed or staged row. */
interface DedupKeys {
  archiveId: string | null;
  contentHash: string;
}

/**
 * Committed rows already holding any of these dedup keys, mapped to the account
 * that holds them: archive_id (S-Pankki, always present) or, for a future bank
 * without one, content_hash among the null-archive_id rows (CLAUDE.md
 * non-negotiable #4 fallback).
 *
 * Analyze and commit both go through this — commit re-verifies what analyze
 * decided, and the two must not drift into different notions of "duplicate".
 */
function findExistingDedupMatches(
  db: Db | Tx,
  rows: DedupKeys[],
): { byArchiveId: Map<string, number>; byContentHash: Map<string, number> } {
  const byArchiveId = new Map<string, number>();
  const byContentHash = new Map<string, number>();

  const archiveIds = [...new Set(rows.map((r) => r.archiveId).filter((v) => v !== null))];
  if (archiveIds.length > 0) {
    for (const t of db
      .select({ archiveId: transactions.archiveId, accountId: transactions.accountId })
      .from(transactions)
      .where(inArray(transactions.archiveId, archiveIds))
      .all()) {
      byArchiveId.set(t.archiveId!, t.accountId);
    }
  }

  const contentHashes = [
    ...new Set(rows.filter((r) => r.archiveId === null).map((r) => r.contentHash)),
  ];
  if (contentHashes.length > 0) {
    for (const t of db
      .select({ contentHash: transactions.contentHash, accountId: transactions.accountId })
      .from(transactions)
      .where(and(isNull(transactions.archiveId), inArray(transactions.contentHash, contentHashes)))
      .all()) {
      byContentHash.set(t.contentHash, t.accountId);
    }
  }

  return { byArchiveId, byContentHash };
}

/** The account already holding this row, or undefined if it is genuinely new. */
function existingAccountIdFor(
  row: DedupKeys,
  matches: ReturnType<typeof findExistingDedupMatches>,
): number | undefined {
  return row.archiveId !== null
    ? matches.byArchiveId.get(row.archiveId)
    : matches.byContentHash.get(row.contentHash);
}

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

  const parsed = rows.map((row) => ({
    row,
    normalizedCounterparty: normalizeCounterparty(row.counterparty),
    contentHash: computeContentHash({
      accountId: params.accountId,
      paymentDate: row.paymentDate,
      amountCents: row.amountCents,
      counterparty: row.counterparty,
      reference: row.reference,
      message: row.message,
    }),
  }));

  const existing = findExistingDedupMatches(
    db,
    parsed.map((p) => ({ archiveId: p.row.archiveId, contentHash: p.contentHash })),
  );

  const seenInBatch = new Set<string>();
  let duplicateCount = 0;

  const values = parsed.map(({ row, normalizedCounterparty, contentHash }) => {
    const dedupKey = row.archiveId !== null ? `arc:${row.archiveId}` : `hash:${contentHash}`;
    const existingAccountId = existingAccountIdFor(
      { archiveId: row.archiveId, contentHash },
      existing,
    );

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

/**
 * Rows dated before the account's opening balance are excluded from commit
 * (decision 001-A). This summary drives the review banner and the 002-E assist.
 */
export interface BeforeOpeningSummary {
  count: number; // before-opening 'new' rows (the ones held back at commit)
  earliestDate: string | null;
  sumNewCents: number; // Σ amount_cents of those rows (== the 002-E recompute delta)
  // The 002-E "Extend history" assist is exact only when the file bridges the
  // gap — its latest row reaches at least the current opening date. Otherwise
  // the excluded rows are a partial history and the recompute would corrupt the
  // opening balance, so the assist is not offered (manual entry is the fallback).
  extendOffered: boolean;
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
  beforeOpening: BeforeOpeningSummary;
}

/** Pure over staged rows + the account's opening date; used by detail + extend. */
function computeBeforeOpening(
  staged: StagedRow[],
  openingBalanceDate: string | null,
): BeforeOpeningSummary {
  const excludedNew = staged.filter((r) => r.dupState === 'new' && r.beforeOpening);
  if (excludedNew.length === 0 || openingBalanceDate === null) {
    return { count: 0, earliestDate: null, sumNewCents: 0, extendOffered: false };
  }
  const earliestDate = excludedNew.reduce(
    (min, r) => (r.paymentDate < min ? r.paymentDate : min),
    excludedNew[0]!.paymentDate,
  );
  const sumNewCents = excludedNew.reduce((sum, r) => sum + r.amountCents, 0);
  const maxPaymentDate = staged.reduce(
    (max, r) => (r.paymentDate > max ? r.paymentDate : max),
    staged[0]!.paymentDate,
  );
  return {
    count: excludedNew.length,
    earliestDate,
    sumNewCents,
    extendOffered: maxPaymentDate >= openingBalanceDate,
  };
}

/**
 * Every import, newest first, optionally narrowed to one status. Drives the
 * pending-review resume list: an interrupted review is otherwise unreachable,
 * since the chosen categories live in `staged_transactions` with nothing
 * pointing at them.
 */
export function listImports(db: Db, status?: ImportRow['status']): ImportRow[] {
  const query = db.select().from(imports).$dynamic();
  return (status ? query.where(eq(imports.status, status)) : query)
    .orderBy(desc(imports.createdAt), desc(imports.id))
    .all();
}

export function getImportDetail(db: Db, importId: number): ImportDetail {
  const [importRow] = db.select().from(imports).where(eq(imports.id, importId)).all();
  if (!importRow) {
    throw new ImportPipelineError('import not found', 404);
  }
  const [account] = db.select().from(accounts).where(eq(accounts.id, importRow.accountId)).all();

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
    beforeOpening: computeBeforeOpening(staged, account?.openingBalanceDate ?? null),
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

  return db.transaction((tx) => {
    // Re-verify dedup against the committed table, here, immediately before
    // inserting: `dup_state` is a snapshot of the world at analyze time, and
    // staging can outlive it (a second analyze of the same file, an
    // interrupted review resumed after another import landed). Committing
    // stale staging IS a re-import, so rows that became duplicates are
    // skipped and counted — never an error, never a constraint violation.
    const existing = findExistingDedupMatches(tx, eligible);
    const insertable = eligible.filter((r) => existingAccountIdFor(r, existing) === undefined);
    const staleCount = eligible.length - insertable.length;

    // Counted after re-verification: a stale uncategorized row must not force
    // the flag for rows that will never be inserted.
    const resolved = insertable.map((row) => resolveFinalCategory(row));
    const unlabeledCount = resolved.filter((r) => r.categoryId === null).length;
    if (unlabeledCount > 0 && !opts.allowUncategorized) {
      throw new ImportPipelineError(
        'some rows are still uncategorized; pass allowUncategorized: true to commit them as Uncategorized',
        400,
      );
    }

    for (let i = 0; i < insertable.length; i++) {
      const row = insertable[i]!;
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

    const duplicates = importRow.duplicateCount + staleCount;
    tx.update(imports)
      .set({ insertedCount: insertable.length, duplicateCount: duplicates, status: 'committed' })
      .where(eq(imports.id, importId))
      .run();
    tx.delete(stagedTransactions).where(eq(stagedTransactions.importId, importId)).run();

    return { inserted: insertable.length, duplicates, uncategorized: unlabeledCount };
  });
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

// --- Re-analysis on an opening-date move ----------------------------------

/**
 * `before_opening` is frozen into `staged_transactions` at analyze time, and
 * commit filters on that stored flag — so moving an account's opening date
 * while an import sits in review would otherwise commit rows on the wrong side
 * of the new boundary. Recompute the flag for every staged `new` row of the
 * account's pending imports, the same way `extendHistory` does for the one
 * import it touches. The status and dup-state filters are defensive rather than
 * load-bearing — commit and discard both delete their staged rows, and only
 * `new` rows are ever read back.
 *
 * Callers must already hold the write transaction that moves the date.
 */
export function reanalyzeStagedBeforeOpening(
  tx: Tx,
  accountId: number,
  openingBalanceDate: string | null,
): void {
  const pending = tx
    .select({
      id: stagedTransactions.id,
      paymentDate: stagedTransactions.paymentDate,
      beforeOpening: stagedTransactions.beforeOpening,
    })
    .from(stagedTransactions)
    .innerJoin(imports, eq(stagedTransactions.importId, imports.id))
    .where(
      and(
        eq(imports.accountId, accountId),
        eq(imports.status, 'pending_review'),
        eq(stagedTransactions.dupState, 'new'),
      ),
    )
    .all();

  for (const row of pending) {
    const beforeOpening = openingBalanceDate !== null && row.paymentDate < openingBalanceDate;
    if (beforeOpening === row.beforeOpening) continue;
    tx.update(stagedTransactions)
      .set({ beforeOpening })
      .where(eq(stagedTransactions.id, row.id))
      .run();
  }
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
 *
 * Enforced server-side: the recompute is exact only when the file bridges the
 * gap (its latest row reaches at least the current opening date). If it does
 * not, the excluded rows are a partial history and the recompute would corrupt
 * the opening balance, so this rejects with 409 (UI hiding the button is not
 * the protection — spec 002 §API surface).
 */
export function extendHistory(db: Db, importId: number): ExtendHistoryResult {
  assertPendingReview(db, importId);

  const staged = db
    .select()
    .from(stagedTransactions)
    .where(eq(stagedTransactions.importId, importId))
    .all();

  const [importRow] = db.select().from(imports).where(eq(imports.id, importId)).all();
  const [account] = db.select().from(accounts).where(eq(accounts.id, importRow!.accountId)).all();

  const summary = computeBeforeOpening(staged, account!.openingBalanceDate);
  if (summary.count === 0) {
    throw new ImportPipelineError('no before-opening rows to extend', 400);
  }
  if (!summary.extendOffered) {
    const maxPaymentDate = staged.reduce(
      (max, r) => (r.paymentDate > max ? r.paymentDate : max),
      staged[0]!.paymentDate,
    );
    throw new ImportPipelineError(
      `this file ends ${maxPaymentDate}, before the account's opening date ` +
        `${account!.openingBalanceDate} — extend history is not available; enter the ` +
        `balance at ${account!.openingBalanceDate} manually`,
      409,
    );
  }

  const earliestDate = summary.earliestDate!;
  const newOpeningCents = account!.openingBalanceCents - summary.sumNewCents;

  db.transaction((tx) => {
    tx.update(accounts)
      .set({ openingBalanceDate: earliestDate, openingBalanceCents: newOpeningCents })
      .where(eq(accounts.id, account!.id))
      .run();

    // Re-analyze in place against the new opening date — every pending import on
    // the account, not just this one: a sibling import in review carries flags
    // frozen against the old date and would drop now-in-window rows at commit.
    reanalyzeStagedBeforeOpening(tx, account!.id, earliestDate);
  });

  return {
    openingBalanceDate: earliestDate,
    openingBalanceCents: newOpeningCents,
    extendedRowCount: summary.count,
  };
}
