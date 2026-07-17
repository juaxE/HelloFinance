import { useEffect, useState } from 'react';
import type { Account, Category, ImportDetail } from '@finance/shared';
import { api } from '../api';
import { ReviewScreen } from './ReviewScreen';

/** Spec 002 "Import page": drag-drop / file picker + account selector -> Analyze. */
export function ImportPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [accountId, setAccountId] = useState<string>('');
  const [file, setFile] = useState<File | null>(null);
  const [detail, setDetail] = useState<ImportDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.listAccounts(), api.listCategories()])
      .then(([a, c]) => {
        setAccounts(a);
        setCategories(c);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'failed to load'));
  }, []);

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
