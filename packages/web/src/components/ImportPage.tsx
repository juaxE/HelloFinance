import { useCallback, useEffect, useState } from 'react';
import type { Account, Category, ImportDetail, ImportSummary } from '@finance/shared';
import { api } from '../api';
import { formatDate } from '../format';
import { ReviewScreen } from './ReviewScreen';

/** Epoch-ms timestamp -> the local calendar day, in the app's DD.MM.YYYY form. */
function formatCreatedAt(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return formatDate(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
}

/** Spec 002 "Import page": drag-drop / file picker + account selector -> Analyze. */
export function ImportPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [pending, setPending] = useState<ImportSummary[]>([]);
  const [accountId, setAccountId] = useState<string>('');
  const [file, setFile] = useState<File | null>(null);
  const [detail, setDetail] = useState<ImportDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A review lives in `staged_transactions`, not in this component's state —
  // closing the tab mid-review must not orphan hours of labeling, so every
  // pending import is offered back on mount and after each commit/discard.
  const refreshPending = useCallback(async () => {
    setPending(await api.listImports('pending_review'));
  }, []);

  useEffect(() => {
    Promise.all([api.listAccounts(), api.listCategories(), refreshPending()])
      .then(([a, c]) => {
        setAccounts(a);
        setCategories(c);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'failed to load'));
  }, [refreshPending]);

  async function handleAnalyze() {
    if (!accountId || !file) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.uploadImport(Number(accountId), file);
      setDetail(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'upload failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleResume(importId: number) {
    setLoading(true);
    setError(null);
    try {
      const resumed = await api.getImport(importId);
      // The listed row can be stale — another tab is exactly the situation
      // resume exists for, and it may have committed or discarded this import
      // since the list was fetched. Opening the review screen anyway would show
      // an empty review whose Commit button silently reports the other tab's
      // result as if it had just happened.
      if (resumed.status !== 'pending_review') {
        setError(`That import is ${resumed.status} — it is no longer in review.`);
        // Outside the catch below: a failing refresh must not overwrite that
        // message with "failed to open import", which would report the one case
        // the guard exists for as something else entirely.
        void refreshPending().catch(() => undefined);
        return;
      }
      setDetail(resumed);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to open import');
    } finally {
      setLoading(false);
    }
  }

  if (detail) {
    return (
      <ReviewScreen
        detail={detail}
        accounts={accounts}
        categories={categories}
        onChange={setDetail}
        onDone={() => {
          setDetail(null);
          setFile(null);
          // A failure here leaves the just-finished import on the list, whose
          // Resume button then leads nowhere — say so rather than swallowing it.
          void refreshPending().catch((e) =>
            setError(e instanceof Error ? e.message : 'failed to refresh pending imports'),
          );
        }}
      />
    );
  }

  return (
    <section>
      <h2>Import a CSV export</h2>
      {error && (
        <p role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}

      {pending.length > 0 && (
        <div data-testid="pending-imports" style={{ marginBottom: '1.5rem' }}>
          <h3>Pending review ({pending.length})</h3>
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Account</th>
                <th>Uploaded</th>
                <th>Rows</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pending.map((imp) => (
                <tr key={imp.id} data-testid="pending-import-row">
                  <td>{imp.filename}</td>
                  <td>
                    {accounts.find((a) => a.id === imp.accountId)?.name ?? `#${imp.accountId}`}
                  </td>
                  <td>{formatCreatedAt(imp.createdAt)}</td>
                  {/*
                    `rowCount - duplicateCount` is the staged 'new' count exactly
                    — but only while the import is pending, which is all this
                    list shows: commit rewrites `duplicateCount` to include rows
                    that went stale. Any future import-history view must read
                    `insertedCount` instead of re-deriving this.
                  */}
                  <td>
                    {imp.rowCount - imp.duplicateCount} new, {imp.duplicateCount} duplicates
                  </td>
                  <td>
                    <button onClick={() => handleResume(imp.id)} disabled={loading}>
                      Resume
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: 'flex', gap: '1rem', alignItems: 'end', flexWrap: 'wrap' }}>
        <label>
          Account
          <br />
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Select an account</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          CSV file
          <br />
          <input
            type="file"
            accept=".csv"
            aria-label="CSV file"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <button onClick={handleAnalyze} disabled={!accountId || !file || loading}>
          {loading ? 'Analyzing…' : 'Analyze'}
        </button>
      </div>
    </section>
  );
}
