/**
 * Net worth (spec 004):
 *
 *   netWorth(M) =  Σ account_balance(account, monthEnd(M))   over ALL accounts
 *                + Σ latest snapshot with month <= M          for investment/other
 *                − Σ latest snapshot with month <= M          for loan
 *
 * Three pinned rules live here, each guarding against an output that looks
 * plausible while being wrong:
 *
 *  - **The 001-A opening-balance boundary.** A balance counts only transactions
 *    with `opening_balance_date <= payment_date <= D`. That lower bound is what
 *    stops back-filled history from double-counting against an opening balance
 *    taken from a recent statement.
 *  - **Pre-opening months contribute 0** (decision 004-E), not the bare opening
 *    balance. The naive read paints a flat line backwards in time over months
 *    the account was not tracked — wrong in the worst way, because it looks right.
 *  - **Archived assets keep contributing** (decision 004-F). `archived_at` is
 *    never consulted here. Filtering archived assets out would silently REWRITE
 *    history, changing what net worth was in 2025 because of a checkbox ticked
 *    in 2026. Ending a contribution is a data step: enter a final 0 snapshot.
 */

import type { Db } from '../db/client';
import { accounts, assetSnapshots, assets, transactions } from '../db/schema';
import { monthDateRange } from '../budgets/months';
import type { NetWorthPoint } from '@finance/shared';

type AccountRow = typeof accounts.$inferSelect;

/**
 * `opening_balance_cents + Σ amount_cents` within the 001-A window, or **0** if
 * the account was not yet open at `asOf` (decision 004-E).
 */
function accountBalanceAt(
  account: AccountRow,
  rows: { accountId: number; paymentDate: string; amountCents: number }[],
  asOf: string,
): number {
  if (account.openingBalanceDate !== null && asOf < account.openingBalanceDate) return 0;
  return rows
    .filter((t) => t.accountId === account.id)
    .filter((t) => account.openingBalanceDate === null || t.paymentDate >= account.openingBalanceDate)
    .filter((t) => t.paymentDate <= asOf)
    .reduce((sum, t) => sum + t.amountCents, account.openingBalanceCents);
}

/**
 * The net-worth trend over `months`.
 *
 * Snapshots are carried forward: the latest one with `month <= M` (decision
 * 004-B), so a month with no new entry reuses the last value instead of dropping
 * to zero. An asset with no snapshot at or before M contributes 0.
 */
export function netWorthTrend(db: Db, months: string[]): NetWorthPoint[] {
  const accountRows = db.select().from(accounts).all();
  const transactionRows = db.select().from(transactions).all();
  const assetRows = db.select().from(assets).all();
  const snapshotRows = db.select().from(assetSnapshots).all();

  return months.map((month) => {
    const asOf = monthDateRange(month).end;

    const accountsCents = accountRows.reduce(
      (sum, account) => sum + accountBalanceAt(account, transactionRows, asOf),
      0,
    );

    let investmentsCents = 0;
    let loansCents = 0;
    for (const asset of assetRows) {
      const value = latestSnapshotValue(snapshotRows, asset.id, month);
      if (asset.kind === 'loan') loansCents += value;
      else investmentsCents += value;
    }

    return {
      month,
      accountsCents,
      investmentsCents,
      loansCents,
      netWorthCents: accountsCents + investmentsCents - loansCents,
      // The step up when a second account starts being tracked is real; the
      // chart marks it so it does not read as a windfall.
      partialAccounts: accountRows.some(
        (a) => a.openingBalanceDate !== null && asOf < a.openingBalanceDate,
      ),
    };
  });
}

/** Carry-forward (004-B): the latest snapshot with `month <= M`, else 0. */
function latestSnapshotValue(
  rows: { assetId: number; month: string; valueCents: number }[],
  assetId: number,
  month: string,
): number {
  let best: { month: string; valueCents: number } | null = null;
  for (const row of rows) {
    if (row.assetId !== assetId || row.month > month) continue;
    if (best === null || row.month > best.month) best = row;
  }
  return best?.valueCents ?? 0;
}
