import { useState } from 'react';
import type { Account, Category, CommitResult, ImportDetail } from '@finance/shared';
import { api } from '../api';
import { formatEur } from '@finance/shared';
import { formatDate } from '../format';
import { GroupCard } from './GroupCard';

interface ReviewScreenProps {
  detail: ImportDetail;
  accounts: Account[];
  categories: Category[];
  onChange: (detail: ImportDetail) => void;
  onDone: () => void;
}

/** Spec 002 "Review screen" — summary banner, group cards, duplicates, sticky footer. */
export function ReviewScreen({ detail, accounts, categories, onChange, onDone }: ReviewScreenProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmUncategorized, setConfirmUncategorized] = useState(false);
  const [result, setResult] = useState<CommitResult | null>(null);

  const allRows = detail.groups.flatMap((g) => g.rows);
  const beforeOpening = detail.beforeOpening;
  const targetAccount = accounts.find((a) => a.id === detail.accountId);
  const eligibleRows = allRows.filter((r) => !r.beforeOpening);
  const unlabeledEligible = eligibleRows.filter(
    (r) => r.chosenCategoryId === null && r.proposedCategoryId === null,
  );
  const labeledGroups = detail.groups.filter(
    (g) => g.chosenCategoryId !== null || g.proposedCategoryId !== null,
  );

  const duplicateAccountNames = new Set(
    detail.duplicates
      .filter((d) => d.duplicateAccountId !== null && d.duplicateAccountId !== detail.accountId)
      .map((d) => accounts.find((a) => a.id === d.duplicateAccountId)?.name ?? `#${d.duplicateAccountId}`),
  );

  async function handleExtendHistory() {
    setBusy(true);
    setError(null);
    try {
      await api.extendHistory(detail.importId);
      const refreshed = await api.getImport(detail.importId);
      onChange(refreshed);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to extend history');
    } finally {
      setBusy(false);
    }
  }

  async function handleDiscard() {
    setBusy(true);
    setError(null);
    try {
      await api.discardImport(detail.importId);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to discard');
    } finally {
      setBusy(false);
    }
  }

  async function handleCommit() {
    if (unlabeledEligible.length > 0 && !confirmUncategorized) {
      setConfirmUncategorized(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const commitResult = await api.commitImport(detail.importId, {
        allowUncategorized: unlabeledEligible.length > 0,
      });
      setResult(commitResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to commit');
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    // The counts are identical whether this call did the work or another tab
    // already had — only `alreadyCommitted` distinguishes them, and reporting a
    // no-op as a fresh import would credit this screen with someone else's rows.
    return (
      <section>
        <h2>{result.alreadyCommitted ? 'Import already committed' : 'Import committed'}</h2>
        <p data-testid="commit-result">
          {result.alreadyCommitted &&
            'This import was committed elsewhere — nothing was inserted. '}
          {result.inserted} inserted, {result.duplicates} duplicates skipped
          {result.uncategorized > 0 && `, ${result.uncategorized} uncategorized`}.
        </p>
        <button onClick={onDone}>Back to import</button>
      </section>
    );
  }

  return (
    <section style={{ paddingBottom: '4.5rem' }}>
      <h2>Review import</h2>
      <p data-testid="import-summary">
        {detail.counts.new} new, {detail.counts.duplicates} duplicates skipped, encoding:{' '}
        {detail.encoding}
        {duplicateAccountNames.size > 0 &&
          ` — already imported into ${[...duplicateAccountNames].join(', ')}`}
      </p>

      {beforeOpening.count > 0 && (
        <div className="card">
          <span className="badge warn">
            {beforeOpening.count} row{beforeOpening.count === 1 ? '' : 's'} dated before the
            account&apos;s opening balance
          </span>{' '}
          — these will not be imported.{' '}
          {beforeOpening.extendOffered ? (
            <button onClick={handleExtendHistory} disabled={busy}>
              Extend history to include them
            </button>
          ) : (
            <span data-testid="extend-unavailable">
              This file ends before the account&apos;s opening date
              {targetAccount?.openingBalanceDate ? ` (${targetAccount.openingBalanceDate})` : ''}, so
              history can&apos;t be extended automatically — enter the balance at that date manually
              in account settings.
            </span>
          )}
        </div>
      )}

      {error && (
        <p role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}

      <h3>Groups ({detail.groups.length})</h3>
      {detail.groups.map((group) => (
        <GroupCard
          key={group.normalizedCounterparty}
          importId={detail.importId}
          group={group}
          categories={categories}
          onUpdated={onChange}
        />
      ))}

      {detail.duplicates.length > 0 && (
        <details>
          <summary>Duplicates ({detail.duplicates.length}, not imported)</summary>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Amount</th>
                <th>Counterparty</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {detail.duplicates.map((d) => (
                <tr key={d.id}>
                  <td>{formatDate(d.paymentDate)}</td>
                  <td>{formatEur(d.amountCents)}</td>
                  <td>{d.counterparty}</td>
                  <td>
                    {d.dupState === 'duplicate_in_batch'
                      ? 'duplicate within this file'
                      : d.duplicateAccountId !== null && d.duplicateAccountId !== detail.accountId
                        ? `already in ${accounts.find((a) => a.id === d.duplicateAccountId)?.name ?? '?'}`
                        : 'already imported'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      <div
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          background: 'var(--bg-subtle)',
          borderTop: '1px solid var(--border)',
          padding: '0.75rem 1rem',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span>
          {labeledGroups.length} of {detail.groups.length} groups labeled
        </span>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {confirmUncategorized && unlabeledEligible.length > 0 && (
            <span className="badge warn">
              {unlabeledEligible.length} rows will import as Uncategorized
            </span>
          )}
          <button onClick={handleDiscard} disabled={busy}>
            Discard
          </button>
          <button onClick={handleCommit} disabled={busy}>
            {confirmUncategorized && unlabeledEligible.length > 0
              ? `Import the rest as Uncategorized (${unlabeledEligible.length})`
              : 'Commit'}
          </button>
        </div>
      </div>
    </section>
  );
}
