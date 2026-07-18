import { useEffect, useState } from 'react';
import type { Category, ImportDetail, StagedGroup } from '@finance/shared';
import { api } from '../api';
import { formatEur } from '@finance/shared';
import { formatDate } from '../format';

interface GroupCardProps {
  importId: number;
  group: StagedGroup;
  categories: Category[];
  onUpdated: (detail: ImportDetail) => void;
}

/**
 * One review-screen card: all staged rows sharing a normalized counterparty
 * (spec 002 UI sketch). The category dropdown is pre-filled from a rule/type
 * hint proposal but that is display-only — nothing is written until "Apply
 * to all N" is clicked, matching decision 002-A (manual beats rule).
 */
export function GroupCard({ importId, group, categories, onUpdated }: GroupCardProps) {
  const [selected, setSelected] = useState(() => initialSelection(group));
  const [remember, setRemember] = useState(group.rememberRule);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelected(initialSelection(group));
    setRemember(group.rememberRule);
  }, [group]);

  const beforeOpeningCount = group.rows.filter((r) => r.beforeOpening).length;

  async function applyToAll() {
    setBusy(true);
    setError(null);
    try {
      const detail = await api.patchGroup(importId, group.normalizedCounterparty, {
        categoryId: selected === '' ? null : Number(selected),
        rememberRule: remember,
      });
      onUpdated(detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to apply');
    } finally {
      setBusy(false);
    }
  }

  async function patchRow(rowId: number, patch: { categoryId?: number | null; note?: string | null }) {
    setBusy(true);
    setError(null);
    try {
      const detail = await api.patchRow(importId, rowId, patch);
      onUpdated(detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to update row');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" data-testid="group-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <strong>{group.exampleRaw}</strong>{' '}
          <span className="badge">{group.normalizedCounterparty}</span>{' '}
          {group.fromRule && <span className="badge rule">from rule</span>}
          {beforeOpeningCount > 0 && (
            <span className="badge warn">{beforeOpeningCount} before opening balance</span>
          )}
          <div style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>
            {group.count} transaction{group.count === 1 ? '' : 's'}, total{' '}
            {formatEur(group.totalAmountCents)}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <select
            aria-label={`Category for ${group.normalizedCounterparty}`}
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={busy}
          >
            <option value="">Uncategorized</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <label style={{ fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            remember as rule
          </label>
          <button onClick={applyToAll} disabled={busy}>
            Apply to all {group.count}
          </button>
          <button onClick={() => setExpanded((v) => !v)} disabled={busy}>
            {expanded ? 'Collapse' : 'Expand'}
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      {expanded && (
        <table style={{ marginTop: '0.5rem' }}>
          <thead>
            <tr>
              <th>Date</th>
              <th>Amount</th>
              <th>Category</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {group.rows.map((row) => (
              <tr key={row.id}>
                <td>
                  {formatDate(row.paymentDate)}
                  {row.beforeOpening && (
                    <>
                      {' '}
                      <span className="badge warn">before opening</span>
                    </>
                  )}
                </td>
                <td>{formatEur(row.amountCents)}</td>
                <td>
                  <select
                    aria-label={`Category for row ${row.id}`}
                    value={row.chosenCategoryId ?? row.proposedCategoryId ?? ''}
                    onChange={(e) =>
                      patchRow(row.id, {
                        categoryId: e.target.value === '' ? null : Number(e.target.value),
                      })
                    }
                    disabled={busy}
                  >
                    <option value="">Uncategorized</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    aria-label={`Note for row ${row.id}`}
                    defaultValue={row.note ?? ''}
                    onBlur={(e) => patchRow(row.id, { note: e.target.value === '' ? null : e.target.value })}
                    disabled={busy}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function initialSelection(group: StagedGroup): string {
  const id = group.chosenCategoryId ?? group.proposedCategoryId;
  return id === null || id === undefined ? '' : String(id);
}
