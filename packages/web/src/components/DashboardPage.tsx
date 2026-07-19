import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  formatEur,
  type AssetSnapshotEntry,
  type BudgetVsActual,
  type CashFlowPoint,
  type CategoryBreakdownEntry,
  type IncomeBreakdown,
  type NetWorthPoint,
  type RecurringCommitments,
} from '@finance/shared';
import { api } from '../api';
import { parseEurosToCents } from '../format';

/**
 * The dashboard (spec 004): net worth, cash flow, income sources, per-category
 * spending, budget vs. actual, the commitments estimate, and asset-snapshot
 * entry.
 *
 * Every figure here is computed by the API — this file formats and nothing else
 * (CLAUDE.md validation §6). Each rendered money value also carries its raw
 * integer cents in a `data-cents` attribute, so the Playwright tie-out compares
 * at the CENTS level rather than string-matching the output of the same
 * formatter the UI used, which would be a tautology.
 */

// Series colors from the validated categorical order. Loans additionally use a
// DASHED stroke: red↔green sits in the 6–8 CVD separation band, which is only
// legal alongside a secondary encoding.
const COLOR = {
  accounts: '#2a78d6',
  investments: '#008300',
  loans: '#e34948',
  netWorth: '#4a3aa7',
  income: '#2a78d6',
  expenses: '#eb6834',
  net: '#4a3aa7',
  spend: '#2a78d6',
} as const;

const WINDOWS = [3, 6, 9, 12] as const;

const card: React.CSSProperties = {
  border: '1px solid #e4e4e1',
  borderRadius: 10,
  padding: '1rem',
  background: '#fff',
};

/** A money value that also carries its raw cents, for the DOM/API tie-out. */
function Money({ cents, testId }: { cents: number; testId: string }) {
  return (
    <span data-testid={testId} data-cents={cents}>
      {formatEur(cents)}
    </span>
  );
}

function Card({
  title,
  subtitle,
  children,
  actions,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section style={card}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', marginBottom: '0.75rem' }}>
        <h2 style={{ fontSize: '0.95rem', margin: 0, whiteSpace: 'nowrap' }}>{title}</h2>
        {subtitle && <span style={{ fontSize: '0.75rem', color: '#6b6a66' }}>{subtitle}</span>}
        <span style={{ flex: 1 }} />
        {actions}
      </header>
      {children}
    </section>
  );
}

function WindowSelector({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div role="group" aria-label="Trend window" style={{ display: 'flex', gap: '0.25rem' }}>
      {WINDOWS.map((w) => (
        <button
          key={w}
          onClick={() => onChange(w)}
          aria-pressed={value === w}
          style={{
            border: '1px solid #e4e4e1',
            background: value === w ? '#2a78d6' : 'transparent',
            color: value === w ? '#fff' : 'inherit',
            borderRadius: 6,
            padding: '0.15rem 0.5rem',
            fontSize: '0.75rem',
          }}
        >
          {w}m
        </button>
      ))}
    </div>
  );
}

const euroAxis = (cents: number): string => `${Math.round(cents / 100)}`;
const tooltipFormatter = (value: number, name: string): [string, string] => [formatEur(value), name];

export function DashboardPage({ onOpenBudgets }: { onOpenBudgets: (month: string) => void }) {
  const [window_, setWindow] = useState<number>(12);
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [netWorth, setNetWorth] = useState<NetWorthPoint[]>([]);
  const [cashFlow, setCashFlow] = useState<CashFlowPoint[]>([]);
  const [income, setIncome] = useState<IncomeBreakdown | null>(null);
  const [breakdown, setBreakdown] = useState<CategoryBreakdownEntry[]>([]);
  const [budget, setBudget] = useState<BudgetVsActual | null>(null);
  const [commitments, setCommitments] = useState<RecurringCommitments | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * The current month comes from the SERVER (the commitments endpoint reports
   * the month it used), never from the browser clock — otherwise a pinned server
   * "today" and the browser's real one would disagree about which month the
   * "month to date" cards are showing.
   */
  const month = commitments?.month ?? null;

  /**
   * Each loader stamps its request and drops the result if a newer one started
   * while it was in flight. Clicking through the window selector fires a fetch
   * per click, and without this a slower earlier response can land last and
   * paint numbers for a window the user is no longer on — the rendered figures
   * would then disagree with the API for the selected window (validation §6).
   */
  const trendsReq = useRef(0);
  const monthReq = useRef(0);

  const loadTrends = useCallback(async (w: number) => {
    const seq = ++trendsReq.current;
    const [nw, cf] = await Promise.all([api.getNetWorth(w), api.getCashFlow(w)]);
    if (seq !== trendsReq.current) return;
    setNetWorth(nw);
    setCashFlow(cf);
  }, []);

  const loadMonth = useCallback(async (target: string) => {
    const seq = ++monthReq.current;
    const [inc, cats, bva] = await Promise.all([
      api.getIncome(target),
      api.getCategoryBreakdown(target),
      api.getBudgetVsActual(target),
    ]);
    if (seq !== monthReq.current) return;
    setIncome(inc);
    setBreakdown(cats);
    setBudget(bva);
  }, []);

  useEffect(() => {
    api
      .getRecurringCommitments()
      .then(setCommitments)
      .catch((e) => setError(e instanceof Error ? e.message : 'failed to load the dashboard'));
  }, []);

  useEffect(() => {
    loadTrends(window_).catch((e) =>
      setError(e instanceof Error ? e.message : 'failed to load the trends'),
    );
  }, [window_, loadTrends]);

  useEffect(() => {
    if (month === null) return;
    loadMonth(month).catch((e) =>
      setError(e instanceof Error ? e.message : 'failed to load the month'),
    );
  }, [month, loadMonth]);

  const partialMonths = netWorth.filter((p) => p.partialAccounts).map((p) => p.month);
  const latest = netWorth.at(-1);

  return (
    <div data-testid="dashboard">
      {error && (
        <p role="alert" style={{ color: '#b3261e' }}>
          {error}
        </p>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: '1rem',
        }}
      >
        <div style={{ gridColumn: '1 / -1' }}>
          <Card
            title="Net worth"
            subtitle={
              partialMonths.length > 0
                ? `${partialMonths.join(', ')}: not every account was open yet`
                : undefined
            }
            actions={
              <>
                <button
                  onClick={() => setShowBreakdown((s) => !s)}
                  aria-pressed={showBreakdown}
                  style={{
                    border: '1px solid #e4e4e1',
                    background: 'transparent',
                    borderRadius: 6,
                    padding: '0.15rem 0.5rem',
                    fontSize: '0.75rem',
                    marginRight: '0.5rem',
                  }}
                >
                  Breakdown
                </button>
                <WindowSelector value={window_} onChange={setWindow} />
              </>
            }
          >
            {latest && (
              <p style={{ fontSize: '1.6rem', margin: '0 0 0.5rem' }}>
                <Money cents={latest.netWorthCents} testId="net-worth-latest" />
              </p>
            )}
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={netWorth} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                <CartesianGrid stroke="#f0f0ee" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} stroke="#c9c8c4" />
                <YAxis tickFormatter={euroAxis} tick={{ fontSize: 11 }} stroke="#c9c8c4" width={56} />
                <Tooltip formatter={tooltipFormatter} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line
                  type="monotone"
                  dataKey="netWorthCents"
                  name="Net worth"
                  stroke={COLOR.netWorth}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
                {showBreakdown && (
                  <Line
                    type="monotone"
                    dataKey="accountsCents"
                    name="Accounts"
                    stroke={COLOR.accounts}
                    strokeWidth={2}
                    dot={false}
                  isAnimationActive={false}
                  />
                )}
                {showBreakdown && (
                  <Line
                    type="monotone"
                    dataKey="investmentsCents"
                    name="Investments"
                    stroke={COLOR.investments}
                    strokeWidth={2}
                    dot={false}
                  isAnimationActive={false}
                  />
                )}
                {showBreakdown && (
                  <Line
                    type="monotone"
                    dataKey="loansCents"
                    name="Loans"
                    stroke={COLOR.loans}
                    strokeWidth={2}
                    strokeDasharray="5 3"
                    dot={false}
                  isAnimationActive={false}
                  />
                )}
              </LineChart>
            </ResponsiveContainer>
            {/* The raw series, for the DOM/API tie-out (and a text alternative). */}
            <ul hidden data-testid="net-worth-series">
              {netWorth.map((p) => (
                <li
                  key={p.month}
                  data-month={p.month}
                  data-cents={p.netWorthCents}
                  data-accounts={p.accountsCents}
                  data-investments={p.investmentsCents}
                  data-loans={p.loansCents}
                  data-partial={String(p.partialAccounts)}
                />
              ))}
            </ul>
          </Card>
        </div>

        <div style={{ gridColumn: '1 / -1' }}>
          <Card title="Cash flow" subtitle="transfers excluded">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={cashFlow} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                <CartesianGrid stroke="#f0f0ee" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} stroke="#c9c8c4" />
                <YAxis tickFormatter={euroAxis} tick={{ fontSize: 11 }} stroke="#c9c8c4" width={56} />
                <Tooltip formatter={tooltipFormatter} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="incomeCents" name="Income" fill={COLOR.income} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                <Bar
                  dataKey="expensesCents"
                  name="Expenses"
                  fill={COLOR.expenses}
                  radius={[4, 4, 0, 0]}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="netCents"
                  name="Net"
                  stroke={COLOR.net}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </BarChart>
            </ResponsiveContainer>
            <ul hidden data-testid="cash-flow-series">
              {cashFlow.map((p) => (
                <li
                  key={p.month}
                  data-month={p.month}
                  data-income={p.incomeCents}
                  data-expenses={p.expensesCents}
                  data-net={p.netCents}
                />
              ))}
            </ul>
          </Card>
        </div>

        <Card title="Income sources" subtitle={month ? `${month} — month to date` : undefined}>
          {income && (
            <>
              <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.35rem 1rem' }}>
                <dt>Salary</dt>
                <dd style={{ margin: 0, textAlign: 'right' }}>
                  <Money cents={income.salaryCents} testId="income-salary" />
                </dd>
                <dt>Other income</dt>
                <dd style={{ margin: 0, textAlign: 'right' }}>
                  <Money cents={income.otherIncomeCents} testId="income-other" />
                </dd>
              </dl>
              <p style={{ fontSize: '0.75rem', color: '#6b6a66', marginBottom: 0 }}>
                Reimbursements are not income — they reduce the category they sit in.
              </p>
            </>
          )}
        </Card>

        <Card title="Recurring commitments" subtitle="estimate">
          {commitments && (
            <>
              <p style={{ fontSize: '1.6rem', margin: '0 0 0.25rem' }}>
                ≈ <Money cents={commitments.normalizedMonthlyCents} testId="commitments-total" />
                <span style={{ fontSize: '0.9rem', color: '#6b6a66' }}> /mo</span>
              </p>
              <p style={{ fontSize: '0.75rem', color: '#6b6a66', marginTop: 0 }}>
                An estimate: quarterly and yearly bills are smoothed into a monthly equivalent, so
                this is not what any single month is billed.
              </p>
              <details>
                <summary style={{ fontSize: '0.8rem', cursor: 'pointer' }}>
                  Per template ({commitments.byTemplate.length})
                </summary>
                <ul style={{ fontSize: '0.8rem', paddingLeft: '1.1rem', margin: '0.5rem 0 0' }}>
                  {commitments.byTemplate.map((t) => (
                    <li key={t.templateId} data-testid={`commitment-${t.templateId}`}>
                      {t.name} — <Money cents={t.monthlyEquivalentCents} testId={`commitment-${t.templateId}-monthly`} />
                      /mo{' '}
                      <span style={{ color: '#6b6a66' }}>
                        ({formatEur(t.amountCents)} every {t.intervalMonths} mo)
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            </>
          )}
        </Card>

        <div style={{ gridColumn: '1 / -1' }}>
          <Card title="Spending by category" subtitle={month ? `${month} — month to date` : undefined}>
            <CategoryBars entries={breakdown} />
          </Card>
        </div>

        <Card
          title="Budget vs. actual"
          subtitle={month ? `${month} — month to date` : undefined}
          actions={
            month && (
              <button
                onClick={() => onOpenBudgets(month)}
                style={{
                  border: '1px solid #e4e4e1',
                  background: 'transparent',
                  borderRadius: 6,
                  padding: '0.15rem 0.5rem',
                  fontSize: '0.75rem',
                }}
              >
                Open Budgets
              </button>
            )
          }
        >
          {budget && <BudgetCard budget={budget} />}
        </Card>

        {month && <AssetSnapshotCard month={month} onSaved={() => loadTrends(window_)} />}
      </div>
    </div>
  );
}

/** Horizontal magnitude bars — one measure, so one hue, sized by share. */
function CategoryBars({ entries }: { entries: CategoryBreakdownEntry[] }) {
  const largest = Math.max(1, ...entries.map((e) => Math.abs(e.amountCents)));
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} data-testid="category-breakdown">
      {entries.map((entry) => (
        <li
          key={entry.categoryId ?? 'uncategorized'}
          data-testid={`category-${entry.categoryId ?? 'uncategorized'}`}
          data-cents={entry.amountCents}
          style={{ display: 'grid', gridTemplateColumns: '15rem 1fr auto', gap: '0.5rem', alignItems: 'center', marginBottom: '0.35rem' }}
        >
          <span style={{ fontSize: '0.85rem', whiteSpace: 'nowrap' }}>
            {entry.name}
            {entry.categoryId === null && (
              <span
                style={{
                  marginLeft: '0.4rem',
                  fontSize: '0.7rem',
                  border: '1px solid #eda100',
                  borderRadius: 4,
                  padding: '0 0.25rem',
                }}
              >
                needs review
              </span>
            )}
          </span>
          <span style={{ background: '#f0f0ee', borderRadius: 4, height: 12 }}>
            <span
              style={{
                display: 'block',
                width: `${(Math.abs(entry.amountCents) / largest) * 100}%`,
                background: entry.color ?? COLOR.spend,
                borderRadius: 4,
                height: 12,
              }}
            />
          </span>
          <span style={{ fontSize: '0.85rem', textAlign: 'right' }}>
            {formatEur(entry.amountCents)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function BudgetCard({ budget }: { budget: BudgetVsActual }) {
  if (!budget.materialized) {
    return <p style={{ fontSize: '0.85rem', color: '#6b6a66' }}>This month has no budget yet.</p>;
  }
  return (
    <>
      <dl style={{ margin: '0 0 0.75rem', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.3rem 1rem' }}>
        <dt>Planned</dt>
        <dd style={{ margin: 0, textAlign: 'right' }}>
          <Money cents={budget.totals.plannedCents} testId="budget-planned" />
        </dd>
        <dt>Actual</dt>
        <dd style={{ margin: 0, textAlign: 'right' }}>
          <Money cents={budget.totals.actualCents} testId="budget-actual" />
        </dd>
        <dt>Total spent</dt>
        <dd style={{ margin: 0, textAlign: 'right' }}>
          <Money cents={budget.totals.expenseCents} testId="budget-expense" />
        </dd>
      </dl>
      {!budget.budgeted && (
        <p style={{ fontSize: '0.75rem', color: '#6b6a66' }}>No category goals set for this month.</p>
      )}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: '0.8rem' }}>
        {budget.lines.slice(0, 6).map((line) => (
          <li
            key={line.id}
            data-testid={`budget-line-${line.id}`}
            data-planned={line.plannedCents}
            data-actual={line.actualCents}
            style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}
          >
            <span>
              {line.name}
              {line.pending && <span style={{ color: '#6b6a66' }}> · pending</span>}
            </span>
            <span>
              {formatEur(line.actualCents)} / {formatEur(line.plannedCents)}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Snapshot entry for the month. Archived assets are absent (decision 004-F), and
 * archiving warns that a non-zero last value keeps carrying forward — offering
 * to enter the closing `0` first, which is the intended way to retire a paid-off
 * loan or a liquidated investment.
 */
function AssetSnapshotCard({ month, onSaved }: { month: string; onSaved: () => void }) {
  const [entries, setEntries] = useState<AssetSnapshotEntry[]>([]);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    const rows = await api.getAssetSnapshots(month);
    setEntries(rows);
    setDrafts(
      Object.fromEntries(
        rows.map((r) => [r.assetId, r.valueCents === null ? '' : formatEur(r.valueCents)]),
      ),
    );
  }, [month]);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  async function save() {
    const values: { assetId: number; valueCents: number }[] = [];
    for (const entry of entries) {
      const parsed = parseEurosToCents(drafts[entry.assetId] ?? '');
      if (parsed === 'invalid') {
        setStatus(`"${entry.name}" is not a valid amount`);
        return;
      }
      // Omitted rather than zeroed: a blank field means "no value entered", and
      // the API leaves an omitted asset untouched.
      if (parsed === null) continue;
      values.push({ assetId: entry.assetId, valueCents: parsed });
    }
    await api.saveAssetSnapshots(month, values);
    setStatus(`Saved ${values.length} value(s) for ${month}`);
    await load();
    onSaved();
  }

  async function archive(entry: AssetSnapshotEntry) {
    const carrying = entry.valueCents !== null && entry.valueCents !== 0;
    const message = carrying
      ? `"${entry.name}" last reported ${formatEur(entry.valueCents!)}. Archiving only hides it from this form — that value keeps counting in net worth every month from now on.\n\nEnter a closing 0 for ${month} first?`
      : `Archive "${entry.name}"? It disappears from this form; its history is kept.`;
    if (carrying) {
      if (window.confirm(message)) {
        await api.saveAssetSnapshots(month, [{ assetId: entry.assetId, valueCents: 0 }]);
      }
    } else if (!window.confirm(message)) {
      return;
    }
    await api.patchAsset(entry.assetId, { archived: true });
    setStatus(`Archived "${entry.name}"`);
    await load();
    onSaved();
  }

  return (
    <Card title="Asset values" subtitle={month}>
      <p style={{ fontSize: '0.75rem', color: '#6b6a66', marginTop: 0 }}>
        Loans are entered as positive balances and subtracted in net worth.
      </p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} data-testid="asset-entry">
        {entries.map((entry) => (
          <li
            key={entry.assetId}
            data-testid={`asset-${entry.assetId}`}
            data-cents={entry.valueCents ?? ''}
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem' }}
          >
            <label style={{ flex: 1, fontSize: '0.85rem' }}>
              {entry.name}
              <span style={{ color: '#6b6a66' }}> · {entry.kind}</span>
              {entry.carriedForward && (
                <span style={{ color: '#6b6a66', fontSize: '0.75rem' }}>
                  {' '}
                  (carried from {entry.sourceMonth})
                </span>
              )}
            </label>
            <input
              aria-label={`${entry.name} value`}
              value={drafts[entry.assetId] ?? ''}
              onChange={(e) => setDrafts((d) => ({ ...d, [entry.assetId]: e.target.value }))}
              style={{ width: '9rem', textAlign: 'right' }}
            />
            <button onClick={() => archive(entry)} style={{ fontSize: '0.75rem' }}>
              Archive
            </button>
          </li>
        ))}
      </ul>
      <button onClick={() => save().catch((e) => setStatus(String(e)))} style={{ marginTop: '0.5rem' }}>
        Save {month}
      </button>
      {status && (
        <p role="status" style={{ fontSize: '0.75rem', color: '#6b6a66' }}>
          {status}
        </p>
      )}
    </Card>
  );
}
