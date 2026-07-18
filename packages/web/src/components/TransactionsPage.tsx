import { useEffect, useState } from 'react';
import type { Account, Category, Transaction } from '@finance/shared';
import { api } from '../api';
import { formatCents, formatDate } from '../format';

/** Spec 002 "Transactions list": shows notes inline, relabel via PATCH. */
export function TransactionsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [accountFilter, setAccountFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingScope, setPendingScope] = useState<{ id: number; categoryId: number } | null>(null);

  useEffect(() => {
    Promise.all([api.listAccounts(), api.listCategories()])
      .then(([a, c]) => {
        setAccounts(a);
        setCategories(c);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'failed to load'));
  }, []);

  useEffect(() => {
    api
      .listTransactions(accountFilter ? { accountId: Number(accountFilter) } : undefined)
      .then(setTransactions)
      .catch((e) => setError(e instanceof Error ? e.message : 'failed to load'));
  }, [accountFilter]);

  async function refresh() {
    const rows = await api.listTransactions(
      accountFilter ? { accountId: Number(accountFilter) } : undefined,
    );
    setTransactions(rows);
  }

  async function applyCategory(id: number, categoryId: number, scope: 'one_off' | 'update_rule') {
    setError(null);
    setNotice(null);
    try {
      const result = await api.patchTransaction(id, { categoryId, scope });
      setPendingScope(null);
      if (result.relabeledCount > 0) {
        setNotice(`Also relabeled ${result.relabeledCount} earlier transaction(s) from this rule.`);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to relabel');
    }
  }

  async function saveNote(id: number, note: string) {
    setError(null);
    try {
      await api.patchTransaction(id, { note: note === '' ? null : note });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to save note');
    }
  }

  return (
    <section>
      <h2>Transactions</h2>
      {error && (
        <p role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <label>
        Account
        <select value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)}>
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Counterparty</th>
            <th>Amount</th>
            <th>Category</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((t) => (
            <tr key={t.id}>
              <td>{formatDate(t.paymentDate)}</td>
              <td>{t.counterparty}</td>
              <td>{formatCents(t.amountCents)}</td>
              <td>
                <select
                  aria-label={`Category for transaction ${t.id}`}
                  value={t.categoryId ?? ''}
                  onChange={(e) => {
                    const categoryId = Number(e.target.value);
                    if (!e.target.value) return;
                    setPendingScope({ id: t.id, categoryId });
                  }}
                >
                  <option value="">Uncategorized</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                {t.categorySource && <span className="badge">{t.categorySource}</span>}
                {pendingScope?.id === t.id && (
                  <div style={{ marginTop: '0.25rem' }}>
                    <button onClick={() => applyCategory(t.id, pendingScope.categoryId, 'one_off')}>
                      Just this one
                    </button>{' '}
                    <button
                      onClick={() => applyCategory(t.id, pendingScope.categoryId, 'update_rule')}
                    >
                      Also update the rule
                    </button>
                  </div>
                )}
              </td>
              <td>
                <input
                  aria-label={`Note for transaction ${t.id}`}
                  defaultValue={t.note ?? ''}
                  onBlur={(e) => saveNote(t.id, e.target.value)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
