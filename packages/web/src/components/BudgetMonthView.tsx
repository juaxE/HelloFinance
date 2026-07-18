import type { BudgetMonth, Category, ReconciledLine } from '@finance/shared';
import { formatCents, formatDate } from '../format';

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
}: {
  month: BudgetMonth;
  categories: Category[];
  onEditGoals: () => void;
  onDeleteLine: (id: number) => void;
}) {
  const categoryName = (id: number) => categories.find((c) => c.id === id)?.name ?? `#${id}`;

  const bills = month.lines.filter((l) => l.kind === 'recurring');
  const oneOffs = month.lines.filter((l) => l.kind === 'adhoc');
  const envelopes = month.lines.filter((l) => l.kind === 'envelope');

  return (
    <section>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: '1rem' }}>
        <h2 style={{ margin: 0 }}>{month.month}</h2>
        {/* Informational, not a scolding: it states a fact (decision 003-K). */}
        {!month.budgeted && (
          <span data-testid="not-budgeted" style={{ color: 'var(--muted)' }}>
            Not budgeted yet — no goals set for this month
          </span>
        )}
        <button onClick={onEditGoals} style={{ marginLeft: 'auto' }}>
          Edit goals
        </button>
      </header>

      <LineGroup
        title="Bills"
        testId="group-bills"
        lines={bills}
        categoryName={categoryName}
        onDeleteLine={onDeleteLine}
        showDay
        emptyText="No recurring bills materialized into this month."
      />
      <LineGroup
        title="One-offs"
        testId="group-oneoffs"
        lines={oneOffs}
        categoryName={categoryName}
        onDeleteLine={onDeleteLine}
        emptyText="No one-off lines this month."
      />
      <LineGroup
        title="Envelopes"
        testId="group-envelopes"
        lines={envelopes}
        categoryName={categoryName}
        onDeleteLine={onDeleteLine}
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
                <td style={{ textAlign: 'right' }}>{formatCents(u.actualCents)}</td>
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
                  style={{
                    textAlign: 'right',
                    color: r.amountCents > 0 ? 'var(--accent)' : 'inherit',
                  }}
                >
                  {formatCents(r.amountCents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <footer data-testid="month-totals" style={{ marginTop: '1.5rem', borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto auto', gap: '0.25rem 1rem', margin: 0 }}>
          <dt>Planned</dt>
          <dd style={{ textAlign: 'right', margin: 0 }}>{formatCents(month.totals.plannedCents)}</dd>
          <dt>Actual (on plan)</dt>
          <dd style={{ textAlign: 'right', margin: 0 }}>{formatCents(month.totals.actualCents)}</dd>
          <dt>Unbudgeted</dt>
          <dd style={{ textAlign: 'right', margin: 0 }}>
            {formatCents(month.totals.unbudgetedCents)}
          </dd>
          <dt>Needs review</dt>
          <dd style={{ textAlign: 'right', margin: 0 }}>
            {formatCents(month.totals.needsReviewCents)}
          </dd>
        </dl>
        {/*
          The tie-out (criterion 10 / CLAUDE.md §6): what the plan accounts for
          must equal the month's expense total exactly. Showing it makes a
          mismatch a visible defect rather than a silent one.
        */}
        <p data-testid="tie-out" style={{ marginBottom: 0 }}>
          Total expenses this month: <strong>{formatCents(month.totals.expenseCents)}</strong>{' '}
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
  showDay = false,
  emptyText,
}: {
  title: string;
  testId: string;
  lines: ReconciledLine[];
  categoryName: (id: number) => string;
  onDeleteLine: (id: number) => void;
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
                <td style={{ textAlign: 'right' }}>{formatCents(line.amountCents)}</td>
                <td style={{ textAlign: 'right' }}>
                  {line.pending ? (
                    <span data-testid="pending" style={{ color: 'var(--muted)' }}>
                      pending
                    </span>
                  ) : (
                    formatCents(line.actualCents)
                  )}
                </td>
                <td style={{ textAlign: 'right' }}>{formatCents(line.varianceCents)}</td>
                <td style={{ width: 120 }}>
                  <VarianceBar planned={line.amountCents} actual={line.actualCents} />
                </td>
                <td>
                  <button
                    aria-label={`Delete line ${line.name}`}
                    onClick={() => onDeleteLine(line.id)}
                  >
                    Delete
                  </button>
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
