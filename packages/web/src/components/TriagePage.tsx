import { useCallback, useEffect, useRef, useState } from 'react';
import { formatEur, type Category, type TriageGroup, type TriageQueue } from '@finance/shared';
import { api } from '../api';
import { formatDate } from '../format';

/**
 * Triage — resolving committed transactions that are still Uncategorized,
 * bunched by normalized counterparty so one decision settles a whole
 * counterparty at once.
 *
 * Repeat groups and singletons are separated because they want different
 * gestures: a repeat group wants one decision applied to many rows, a singleton
 * wants a fast pass down a list. `MOB.PAY*` is stripped by the normalizer, so
 * MobilePay payments key on the recipient and land among the singletons on
 * their own.
 *
 * Applying is never gated by a confirmation — a confirm per group would defeat
 * the point of the view. The undo bar is what makes the fast path safe.
 */

const smallButton: React.CSSProperties = {
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'inherit',
  borderRadius: 6,
  padding: '0.2rem 0.6rem',
};

/**
 * `lastApply` is owned by `App`, not by this component: leaving for the Rules
 * screen to check what a remembered rule did and coming back unmounts this
 * page, and an undo that disappears on a glance elsewhere is not an undo. The
 * server holds the matching slot for the process lifetime.
 */
export function TriagePage({
  onOpenRules,
  onChanged,
  lastApply,
  setLastApply,
}: {
  onOpenRules: () => void;
  onChanged: () => void;
  lastApply: { undoToken: string; label: string } | null;
  setLastApply: (value: { undoToken: string; label: string } | null) => void;
}) {
  const [queue, setQueue] = useState<TriageQueue | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);
  const firstGroupRef = useRef<HTMLSelectElement>(null);

  const load = useCallback(async () => {
    const [q, cats] = await Promise.all([api.getTriageQueue(), api.listCategories()]);
    setQueue(q);
    setCategories(cats);
    onChanged();
  }, [onChanged]);

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : 'failed to load the queue'));
  }, [load]);

  const categoryName = (id: number): string =>
    categories.find((c) => c.id === id)?.name ?? `category ${id}`;

  async function apply(group: TriageGroup, categoryId: number, rememberRule: boolean) {
    setError(null);
    try {
      const result = await api.applyTriageGroup({
        normalizedCounterparty: group.normalizedCounterparty,
        categoryId,
        rememberRule,
      });
      setLastApply({
        undoToken: result.undoToken,
        label: `Categorized ${result.appliedCount} as ${categoryName(categoryId)}${
          result.ruleCreated ? `, and remembered the rule` : ''
        }`,
      });
      await load();
      // The settled group is gone from the list, so put the caret on what is now
      // the top of the queue rather than leaving it on a removed node.
      firstGroupRef.current?.focus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to apply');
    }
  }

  async function undo() {
    if (!lastApply) return;
    setError(null);
    try {
      await api.undoTriageApply(lastApply.undoToken);
      setLastApply(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to undo');
    }
  }

  async function categorizeRow(transactionId: number, categoryId: number) {
    setError(null);
    try {
      await api.patchTransaction(transactionId, { categoryId, scope: 'one_off' });
      setLastApply(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to categorize');
    }
  }

  if (!queue) {
    return <p data-testid="triage-loading">Loading…</p>;
  }

  const repeats = queue.groups.filter((g) => g.count > 1);
  const singletons = queue.groups.filter((g) => g.count === 1);

  return (
    <div data-testid="triage">
      {error && (
        <p role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}

      {lastApply && (
        <div
          className="card"
          role="status"
          data-testid="triage-undo-bar"
          style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}
        >
          <span>{lastApply.label}</span>
          <button onClick={undo} data-testid="triage-undo" style={smallButton}>
            Undo
          </button>
        </div>
      )}

      {queue.totalCount === 0 ? (
        <p data-testid="triage-empty">Nothing to sort — every transaction has a category.</p>
      ) : (
        <p style={{ color: 'var(--muted)' }} data-testid="triage-summary">
          {queue.totalCount} transaction{queue.totalCount === 1 ? '' : 's'} in {queue.groups.length}{' '}
          group{queue.groups.length === 1 ? '' : 's'}
        </p>
      )}

      {repeats.length > 0 && (
        <section>
          <h2 style={{ fontSize: '1rem' }}>Repeat counterparties</h2>
          {repeats.map((group, i) => (
            <TriageGroupCard
              key={group.normalizedCounterparty}
              group={group}
              categories={categories}
              categoryName={categoryName}
              selectRef={i === 0 ? firstGroupRef : undefined}
              onApply={apply}
              onCategorizeRow={categorizeRow}
              onOpenRules={onOpenRules}
            />
          ))}
        </section>
      )}

      {singletons.length > 0 && (
        <section>
          <h2 style={{ fontSize: '1rem' }}>One at a time</h2>
          <p style={{ color: 'var(--muted)', fontSize: '0.85rem', marginTop: 0 }}>
            Seen once each, so they get no rule.
          </p>
          {singletons.map((group) => (
            <SingletonRow
              key={group.normalizedCounterparty}
              group={group}
              categories={categories}
              onApply={apply}
            />
          ))}
        </section>
      )}
    </div>
  );
}

function TriageGroupCard({
  group,
  categories,
  categoryName,
  selectRef,
  onApply,
  onCategorizeRow,
  onOpenRules,
}: {
  group: TriageGroup;
  categories: Category[];
  categoryName: (id: number) => string;
  selectRef?: React.RefObject<HTMLSelectElement>;
  onApply: (group: TriageGroup, categoryId: number, rememberRule: boolean) => Promise<void>;
  onCategorizeRow: (transactionId: number, categoryId: number) => Promise<void>;
  onOpenRules: () => void;
}) {
  const [selected, setSelected] = useState(() =>
    group.existingRule ? String(group.existingRule.categoryId) : '',
  );
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);

  const categoryId = selected === '' ? null : Number(selected);
  // A rule pointing somewhere else can only be changed on the Rules screen,
  // where the retroactive blast radius is visible. Here the bulk path closes and
  // the per-row path stays open.
  const ruleConflict =
    group.existingRule !== null && categoryId !== null && group.existingRule.categoryId !== categoryId;
  const canApply = categoryId !== null && !ruleConflict && !busy;

  async function run(rememberRule: boolean) {
    if (categoryId === null) return;
    setBusy(true);
    try {
      await onApply(group, categoryId, rememberRule);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" data-testid={`triage-group-${group.normalizedCounterparty}`}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <strong>{group.exampleRaw}</strong> <span className="badge">{group.normalizedCounterparty}</span>{' '}
          {group.existingRule && (
            <span className="badge rule" data-testid="triage-existing-rule">
              rule → {categoryName(group.existingRule.categoryId)}
            </span>
          )}
          <div style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>
            {group.count} transactions, total {formatEur(group.totalAmountCents)}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <select
            ref={selectRef}
            aria-label={`Category for ${group.normalizedCounterparty}`}
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canApply) {
                e.preventDefault();
                void run(!group.existingRule);
              }
            }}
            disabled={busy}
          >
            <option value="">Pick a category</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button
            onClick={() => run(false)}
            disabled={!canApply}
            data-testid={`triage-apply-${group.normalizedCounterparty}`}
          >
            Apply to all {group.count}
          </button>
          {!group.existingRule && (
            <button
              onClick={() => run(true)}
              disabled={!canApply}
              data-testid={`triage-remember-${group.normalizedCounterparty}`}
            >
              Apply to all {group.count} and remember
            </button>
          )}
          <button onClick={() => setExpanded((v) => !v)} disabled={busy} style={smallButton}>
            {expanded ? 'Collapse' : 'Expand'}
          </button>
        </div>
      </div>

      {ruleConflict && (
        <p
          style={{ color: 'var(--warn)', fontSize: '0.85rem' }}
          data-testid={`triage-conflict-${group.normalizedCounterparty}`}
        >
          A rule already sends {group.normalizedCounterparty} to{' '}
          {categoryName(group.existingRule!.categoryId)}. Change the rule on the{' '}
          <button
            onClick={onOpenRules}
            style={{ ...smallButton, border: 'none', padding: 0, textDecoration: 'underline' }}
          >
            Rules screen
          </button>
          , or expand this group and set these transactions one at a time.
        </p>
      )}

      {expanded && (
        <table style={{ marginTop: '0.5rem' }}>
          <thead>
            <tr>
              <th>Date</th>
              <th>Amount</th>
              <th>Counterparty</th>
              <th>Category</th>
            </tr>
          </thead>
          <tbody>
            {group.rows.map((row) => (
              <tr key={row.id}>
                <td>{formatDate(row.paymentDate)}</td>
                <td>{formatEur(row.amountCents)}</td>
                <td>{row.counterparty}</td>
                <td>
                  <select
                    aria-label={`Category for transaction ${row.id}`}
                    defaultValue=""
                    onChange={(e) => {
                      if (e.target.value !== '') {
                        void onCategorizeRow(row.id, Number(e.target.value));
                      }
                    }}
                  >
                    <option value="">Uncategorized</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SingletonRow({
  group,
  categories,
  onApply,
}: {
  group: TriageGroup;
  categories: Category[];
  onApply: (group: TriageGroup, categoryId: number, rememberRule: boolean) => Promise<void>;
}) {
  const [selected, setSelected] = useState('');
  const row = group.rows[0]!;
  const categoryId = selected === '' ? null : Number(selected);

  return (
    <div
      className="card"
      data-testid={`triage-singleton-${group.normalizedCounterparty}`}
      style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}
    >
      <span style={{ flex: 1 }}>
        <strong>{group.exampleRaw}</strong>
        <span style={{ color: 'var(--muted)' }}>
          {' '}
          · {formatDate(row.paymentDate)} · {formatEur(row.amountCents)}
        </span>
      </span>
      <select
        aria-label={`Category for ${group.normalizedCounterparty}`}
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && categoryId !== null) {
            e.preventDefault();
            void onApply(group, categoryId, false);
          }
        }}
      >
        <option value="">Pick a category</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <button
        onClick={() => categoryId !== null && onApply(group, categoryId, false)}
        disabled={categoryId === null}
        data-testid={`triage-apply-${group.normalizedCounterparty}`}
      >
        Apply
      </button>
    </div>
  );
}
