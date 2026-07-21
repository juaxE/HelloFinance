import { useEffect, useState } from 'react';
import type { BudgetMonth, Category, ReconciledLine } from '@finance/shared';
import { formatEur } from '@finance/shared';
import { formatDate, parseEurosToCents } from '../format';

/**
 * The month view (spec 003). Lines are grouped by **provenance** — Bills
 * (recurring), One-offs (ad-hoc), Envelopes — while their reconciliation
 * behavior follows the match key, so named rows say so explicitly: an amount
 * showing under a category the transaction isn't labeled with is then
 * explicable rather than a mystery (decision 003-G).
 *
 * Tone matters here and is a spec decision, not taste (003-K): "unbudgeted" is
 * a normal state reported neutrally — no badges, no nag counts, no warning
 * colors on an empty category.
 */
export function BudgetMonthView({
  month,
  categories,
  onEditGoals,
  onDeleteLine,
  onAddOneOff,
  onSaveNote,
}: {
  month: BudgetMonth;
  categories: Category[];
  onEditGoals: () => void;
  onDeleteLine: (id: number) => void;
  onAddOneOff: (input: {
    name: string;
    categoryId: number;
    amountCents: number;
    matchNormalizedCounterparty: string;
  }) => Promise<void>;
  onSaveNote: (note: string | null) => Promise<void>;
}) {
  const categoryName = (id: number) => categories.find((c) => c.id === id)?.name ?? `#${id}`;

  const bills = month.lines.filter((l) => l.kind === 'recurring');
  const oneOffs = month.lines.filter((l) => l.kind === 'adhoc');
  const envelopes = month.lines.filter((l) => l.kind === 'envelope');

  // A closed month is a historical record (proposal 007). The server 409s on
  // every write to it; this just stops the screen offering dead buttons.
  const closed = month.closed;

  return (
    <section>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: '1rem' }}>
        <h2 style={{ margin: 0 }}>{month.month}</h2>
        {closed && (
          <span data-testid="month-closed" style={{ color: 'var(--muted)' }}>
            Closed month — historical record
          </span>
        )}
        {/* Informational, not a scolding: it states a fact (decision 003-K). */}
        {!month.budgeted && (
          <span data-testid="not-budgeted" style={{ color: 'var(--muted)' }}>
            Not budgeted yet — no goals set for this month
          </span>
        )}
        {!closed && (
          <button onClick={onEditGoals} style={{ marginLeft: 'auto' }}>
            Edit goals
          </button>
        )}
      </header>

      {closed ? <ClosedMonthNote note={month.note} /> : <MonthNote note={month.note} onSave={onSaveNote} />}

      <LineGroup
        title="Bills"
        testId="group-bills"
        lines={bills}
        categoryName={categoryName}
        onDeleteLine={onDeleteLine}
        closed={closed}
        showDay
        emptyText="No recurring bills materialized into this month."
      />
      <LineGroup
        title="One-offs"
        testId="group-oneoffs"
        lines={oneOffs}
        categoryName={categoryName}
        onDeleteLine={onDeleteLine}
        closed={closed}
        emptyText="No one-off lines this month."
      />
      {!closed && <AddOneOffForm categories={categories} onAdd={onAddOneOff} />}
      <LineGroup
        title="Envelopes"
        testId="group-envelopes"
        lines={envelopes}
        categoryName={categoryName}
        onDeleteLine={onDeleteLine}
        closed={closed}
        emptyText="No category goals set for this month."
      />

      <h3>Unbudgeted</h3>
      <p style={{ color: 'var(--muted)', marginTop: 0 }}>
        Spending in categories with no goal this month. This is a normal state.
      </p>
      {month.unbudgeted.length === 0 ? (
        <p data-testid="unbudgeted-empty">Nothing unbudgeted.</p>
      ) : (
        <table data-testid="unbudgeted">
          <tbody>
            {month.unbudgeted.map((u) => (
              <tr key={u.categoryId}>
                <td>{categoryName(u.categoryId)}</td>
                <td style={{ textAlign: 'right' }}>{formatEur(u.actualCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Needs review</h3>
      <p style={{ color: 'var(--muted)', marginTop: 0 }}>
        Uncategorized transactions in this month. Label them on the Transactions
        screen and they will move into a category.
      </p>
      {month.needsReview.length === 0 ? (
        <p data-testid="needs-review-empty">Nothing to review.</p>
      ) : (
        <table data-testid="needs-review">
          <tbody>
            {month.needsReview.map((r) => (
              <tr key={r.transactionId}>
                <td>{formatDate(r.paymentDate)}</td>
                <td>{r.counterparty}</td>
                {/*
                  SIGNED on purpose: this bucket can hold positive rows (an
                  uncategorized payback), and rendering those as spending would
                  misreport them.
                */}
                <td
                  data-testid="needs-review-amount"
                  style={{
                    textAlign: 'right',
                    color: r.amountCents > 0 ? 'var(--accent)' : 'inherit',
                  }}
                >
                  {formatEur(r.amountCents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <footer data-testid="month-totals" style={{ marginTop: '1.5rem', borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto auto', gap: '0.25rem 1rem', margin: 0 }}>
          <dt>Planned</dt>
          <dd style={{ textAlign: 'right', margin: 0 }}>{formatEur(month.totals.plannedCents)}</dd>
          <dt>Actual (on plan)</dt>
          <dd style={{ textAlign: 'right', margin: 0 }}>{formatEur(month.totals.actualCents)}</dd>
          <dt>Unbudgeted</dt>
          <dd style={{ textAlign: 'right', margin: 0 }}>
            {formatEur(month.totals.unbudgetedCents)}
          </dd>
          <dt>Needs review</dt>
          <dd style={{ textAlign: 'right', margin: 0 }}>
            {formatEur(month.totals.needsReviewCents)}
          </dd>
        </dl>
        {/*
          The tie-out (criterion 10 / CLAUDE.md §6): what the plan accounts for
          must equal the month's expense total exactly. Showing it makes a
          mismatch a visible defect rather than a silent one.
        */}
        <p data-testid="tie-out" style={{ marginBottom: 0 }}>
          Total expenses this month: <strong>{formatEur(month.totals.expenseCents)}</strong>{' '}
          {tieOutHolds(month) ? (
            <span style={{ color: 'var(--muted)' }}>— reconciles exactly</span>
          ) : (
            <span role="alert" style={{ color: 'var(--danger)' }}>
              — does NOT reconcile
            </span>
          )}
        </p>
      </footer>
    </section>
  );
}

/**
 * The month-level note (spec 003's UI sketch). Saved explicitly rather than on
 * every keystroke — a budget month is a record, not a scratchpad.
 */
function MonthNote({
  note,
  onSave,
}: {
  note: string | null;
  onSave: (note: string | null) => Promise<void>;
}) {
  const [text, setText] = useState(note ?? '');
  const [saving, setSaving] = useState(false);

  // The note belongs to the month; switching months must not carry it over.
  useEffect(() => setText(note ?? ''), [note]);

  const dirty = text !== (note ?? '');

  return (
    <div style={{ margin: '0.5rem 0 1rem' }}>
      <label>
        <span style={{ color: 'var(--muted)', marginRight: '0.5rem' }}>Note</span>
        <input
          data-testid="month-note"
          aria-label="Month note"
          value={text}
          placeholder="Anything worth remembering about this month"
          onChange={(e) => setText(e.target.value)}
          style={{ width: '28rem', maxWidth: '100%' }}
        />
      </label>
      {dirty && (
        <button
          data-testid="save-month-note"
          disabled={saving}
          style={{ marginLeft: '0.5rem' }}
          onClick={async () => {
            setSaving(true);
            try {
              await onSave(text.trim() === '' ? null : text);
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? 'Saving…' : 'Save note'}
        </button>
      )}
    </div>
  );
}

/** The same note, in a closed month: shown as the record it is, not an input. */
function ClosedMonthNote({ note }: { note: string | null }) {
  if (note === null) return null;
  return (
    <p data-testid="month-note-readonly" style={{ margin: '0.5rem 0 1rem' }}>
      <span style={{ color: 'var(--muted)', marginRight: '0.5rem' }}>Note</span>
      {note}
    </p>
  );
}

/**
 * Add an ad-hoc line. A counterparty is **required** (decision 003-J): an
 * unnamed one-off would be a category-level goal, which is what an envelope
 * already is, so the form says so rather than letting the API 400 explain it.
 */
function AddOneOffForm({
  categories,
  onAdd,
}: {
  categories: Category[];
  onAdd: (input: {
    name: string;
    categoryId: number;
    amountCents: number;
    matchNormalizedCounterparty: string;
  }) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [amount, setAmount] = useState('');
  const [counterparty, setCounterparty] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    const amountCents = parseEurosToCents(amount);
    if (amountCents === null || amountCents === 'invalid') {
      setError('Enter an amount, e.g. 120,00');
      return;
    }
    if (categoryId === '') {
      setError('Pick a category');
      return;
    }
    if (counterparty.trim() === '') {
      setError('A one-off needs a counterparty — for a category goal, raise the envelope instead');
      return;
    }
    setBusy(true);
    try {
      await onAdd({
        name: name.trim() === '' ? counterparty.trim() : name.trim(),
        categoryId: Number(categoryId),
        amountCents,
        matchNormalizedCounterparty: counterparty.trim(),
      });
      setName('');
      setCategoryId('');
      setAmount('');
      setCounterparty('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to add the line');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="add-one-off" style={{ margin: '0.5rem 0 1.5rem' }}>
      <h4 style={{ margin: '0 0 0.5rem' }}>Add a one-off (needs a counterparty)</h4>
      {error && (
        <p role="alert" style={{ color: 'var(--danger)', margin: '0 0 0.5rem' }}>
          {error}
        </p>
      )}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <label>
          Name
          <input aria-label="One-off name" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Category
          <select
            aria-label="One-off category"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            <option value="">—</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Amount (€)
          <input
            aria-label="One-off amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label>
          Counterparty
          <input
            aria-label="One-off counterparty"
            value={counterparty}
            onChange={(e) => setCounterparty(e.target.value)}
          />
        </label>
        <button data-testid="add-one-off-submit" disabled={busy} onClick={submit}>
          Add one-off
        </button>
      </div>
    </div>
  );
}

function tieOutHolds(month: BudgetMonth): boolean {
  const t = month.totals;
  return t.actualCents + t.unbudgetedCents + t.needsReviewCents === t.expenseCents;
}

function LineGroup({
  title,
  testId,
  lines,
  categoryName,
  onDeleteLine,
  closed,
  showDay = false,
  emptyText,
}: {
  title: string;
  testId: string;
  lines: ReconciledLine[];
  categoryName: (id: number) => string;
  onDeleteLine: (id: number) => void;
  closed: boolean;
  showDay?: boolean;
  emptyText: string;
}) {
  return (
    <>
      <h3>{title}</h3>
      {lines.length === 0 ? (
        <p style={{ color: 'var(--muted)' }}>{emptyText}</p>
      ) : (
        <table data-testid={testId}>
          <thead>
            <tr>
              <th>Line</th>
              <th>Category</th>
              {showDay && <th>Due</th>}
              <th style={{ textAlign: 'right' }}>Planned</th>
              <th style={{ textAlign: 'right' }}>Actual</th>
              <th style={{ textAlign: 'right' }}>Variance</th>
              <th></th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id} data-testid="budget-line">
                <td>
                  {line.name}
                  {line.matchNormalizedCounterparty && (
                    <span style={{ color: 'var(--muted)' }}>
                      {' '}
                      — matches {line.matchNormalizedCounterparty}
                    </span>
                  )}
                  {line.note && (
                    <div style={{ color: 'var(--muted)', fontSize: '0.85em' }}>{line.note}</div>
                  )}
                </td>
                <td>{categoryName(line.categoryId)}</td>
                {showDay && <td>{line.expectedDayOfMonth ?? ''}</td>}
                <td style={{ textAlign: 'right' }}>{formatEur(line.amountCents)}</td>
                <td style={{ textAlign: 'right' }}>
                  {line.pending ? (
                    <span data-testid="pending" style={{ color: 'var(--muted)' }}>
                      pending
                    </span>
                  ) : (
                    formatEur(line.actualCents)
                  )}
                </td>
                <td style={{ textAlign: 'right' }}>{formatEur(line.varianceCents)}</td>
                <td style={{ width: 120 }}>
                  <VarianceBar planned={line.amountCents} actual={line.actualCents} />
                </td>
                <td>
                  {!closed && (
                    <button
                      aria-label={`Delete line ${line.name}`}
                      onClick={() => onDeleteLine(line.id)}
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/**
 * Actual against planned. Over-plan fills the bar in the "over" tone; nothing
 * here judges an under-spend — the spec is explicit that these are reports, not
 * verdicts.
 */
function VarianceBar({ planned, actual }: { planned: number; actual: number }) {
  const over = actual > planned;
  const ratio = planned === 0 ? (actual > 0 ? 1 : 0) : Math.min(actual / planned, 1);
  return (
    <div
      aria-hidden
      style={{ background: 'var(--border)', borderRadius: 3, height: 8, overflow: 'hidden' }}
    >
      <div
        style={{
          width: `${Math.max(0, ratio) * 100}%`,
          height: '100%',
          background: over ? 'var(--danger)' : 'var(--accent)',
        }}
      />
    </div>
  );
}
