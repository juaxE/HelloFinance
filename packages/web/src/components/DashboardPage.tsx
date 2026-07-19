import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
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
  type BudgetTrendPoint,
  type CashFlowPoint,
  type CategoryTrend,
  type IncomePoint,
  type NetWorthPoint,
  type RecurringCommitments,
} from '@finance/shared';
import { api } from '../api';

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
 *
 * The flow cards — income, spending, budget — are TRENDS, not single months.
 * A flow accumulates over a period, so the month in progress is an incomplete
 * period rather than a small one; showing it alone invited reading a half-lived
 * month as a bad month. It is charted at reduced opacity and excluded from
 * every window total. Net worth is exempt because a balance is a stock and is
 * complete at any instant.
 */

// Series colors from the validated categorical order. Loans additionally use a
// DASHED stroke: red↔green sits in the 6–8 CVD separation band, which is only
// legal alongside a secondary encoding. The dark row keeps that hue order but
// lightened for a dark card, where the light row's green and indigo fall to
// roughly 2.5:1 — more than a 2px stroke can carry.
const SERIES = {
  light: {
    accounts: '#2a78d6',
    investments: '#008300',
    loans: '#e34948',
    netWorth: '#4a3aa7',
    income: '#2a78d6',
    expenses: '#eb6834',
    net: '#4a3aa7',
    salary: '#2a78d6',
    otherIncome: '#00767a',
    planned: '#767672',
    actual: '#2a78d6',
  },
  dark: {
    accounts: '#6ea1ff',
    investments: '#4bb54b',
    loans: '#ff7b78',
    netWorth: '#9c8ff0',
    income: '#6ea1ff',
    expenses: '#ff9a6b',
    net: '#9c8ff0',
    salary: '#6ea1ff',
    otherIncome: '#4fb3b8',
    planned: '#6d6d6d',
    actual: '#6ea1ff',
  },
} as const;

/**
 * The stacked spending bands, assigned by RANK rather than from each category's
 * own `color`.
 *
 * The single-month bar list uses the category's colour, which is fine when one
 * bar per row never needs two colours to be told apart. A stack does: adjacent
 * bands must separate, and user-chosen colours carry no such guarantee. The
 * last two slots are fixed — the collapsed remainder reads as neutral grey, and
 * Uncategorized keeps the same amber it wears everywhere else as needs-review.
 */
const SPEND_PALETTE = {
  light: ['#2a78d6', '#008300', '#eb6834', '#4a3aa7', '#00767a'],
  dark: ['#6ea1ff', '#4bb54b', '#ff9a6b', '#d98cf0', '#4fb3b8'],
} as const;
const REST_COLOR = { light: '#767672', dark: '#6d6d6d' } as const;
const UNCATEGORIZED_COLOR = { light: '#a76a00', dark: '#e0a33a' } as const;

/**
 * The month in progress is marked with a HATCH, not a fade.
 *
 * Fading was the obvious choice and is unusable: to keep a partial bar at the
 * 3:1 non-text contrast floor, the collapsed-remainder grey needs alpha 0.92 on
 * the dark card and 1.00 on the light one — i.e. no fade at all. Opacity cannot
 * both signal "incomplete" and stay legible.
 *
 * The hatch keeps the band at full strength and stripes it with a lighter (dark
 * theme) or darker (light theme) shade of its own colour, so base and stripe
 * both clear 3:1 and the signal survives greyscale and every CVD type — it is
 * not carried by hue or luminance at all.
 */
const HATCH_MIX = { light: { target: '#000000', amount: 0.3 }, dark: { target: '#ffffff', amount: 0.45 } } as const;

function mix(from: string, to: string, amount: number): string {
  const channels = (hex: string): number[] =>
    [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [a, b] = [channels(from), channels(to)];
  return `#${a.map((v, i) => Math.round(v * (1 - amount) + b[i]! * amount).toString(16).padStart(2, '0')).join('')}`;
}

const hatchId = (color: string): string => `hatch-${color.slice(1)}`;

/** Solid when the month is complete, hatched while it is still filling. */
const fillFor = (color: string, partial: boolean): string =>
  partial ? `url(#${hatchId(color)})` : color;

/**
 * One document-global `<defs>` for every hatch the page can use. Kept outside
 * the charts because SVG pattern ids resolve document-wide, and repeating them
 * per chart would define the same id several times.
 */
function HatchDefs({ colors, theme }: { colors: string[]; theme: 'light' | 'dark' }) {
  const { target, amount } = HATCH_MIX[theme];
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        {[...new Set(colors)].map((color) => (
          <pattern
            key={color}
            id={hatchId(color)}
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="6" height="6" fill={color} />
            <rect width="2" height="6" fill={mix(color, target, amount)} />
          </pattern>
        ))}
      </defs>
    </svg>
  );
}

const WINDOWS = [3, 6, 9, 12] as const;

/**
 * Chart chrome is resolved in JS, not from the CSS custom properties the rest of
 * this file uses: Recharts emits `stroke`/`fill` as SVG presentation attributes,
 * and `var()` is not valid there — it would silently paint nothing.
 */
const CHROME = {
  light: { grid: '#f0f0ee', axis: '#c9c8c4', tooltipBg: '#ffffff', tooltipText: '#1a1a1a' },
  dark: { grid: '#2a2a2a', axis: '#5a5a5a', tooltipBg: '#1c1c1c', tooltipText: '#e8e8e6' },
} as const;

function usePrefersDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return dark;
}

const card: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: '1rem',
  background: 'var(--bg-card)',
  color: 'var(--text)',
};

const smallButton: React.CSSProperties = {
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'inherit',
  borderRadius: 6,
  padding: '0.15rem 0.5rem',
  fontSize: '0.75rem',
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
        {subtitle && <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>{subtitle}</span>}
        <span style={{ flex: 1 }} />
        {actions}
      </header>
      {children}
    </section>
  );
}

function WindowSelector({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div role="group" aria-label="Trend window" style={{ display: 'flex', gap: '0.25rem' }}>
      {WINDOWS.map((w) => (
        <button
          key={w}
          onClick={() => onChange(w)}
          aria-pressed={value === w}
          style={{
            ...smallButton,
            background: value === w ? 'var(--accent)' : 'transparent',
            color: value === w ? 'var(--accent-contrast)' : 'inherit',
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

/**
 * The window figure for a flow card: a SUM over the complete months, never an
 * average. Averaging would divide money, and division is confined to the
 * commitments estimate with pinned rounding (CLAUDE.md); every other cent
 * figure in the app is exact integer arithmetic.
 */
function completeTotal<T extends { partial: boolean }>(points: T[], value: (p: T) => number): number {
  return points.filter((p) => !p.partial).reduce((sum, p) => sum + value(p), 0);
}

function partialNote(months: { month: string; partial: boolean }[]): string | undefined {
  const partial = months.find((m) => m.partial);
  return partial ? `${partial.month} still in progress — excluded from the total` : undefined;
}

export function DashboardPage({
  onOpenBudgets,
  onOpenTriage,
}: {
  onOpenBudgets: () => void;
  onOpenTriage: () => void;
}) {
  const theme = usePrefersDark() ? 'dark' : 'light';
  const series = SERIES[theme];
  const chrome = CHROME[theme];
  const [window_, setWindow] = useState<number>(12);
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [netWorth, setNetWorth] = useState<NetWorthPoint[]>([]);
  const [cashFlow, setCashFlow] = useState<CashFlowPoint[]>([]);
  const [income, setIncome] = useState<IncomePoint[]>([]);
  const [spending, setSpending] = useState<CategoryTrend | null>(null);
  const [budget, setBudget] = useState<BudgetTrendPoint[]>([]);
  const [commitments, setCommitments] = useState<RecurringCommitments | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Each loader stamps its request and drops the result if a newer one started
   * while it was in flight. Clicking through the window selector fires a fetch
   * per click, and without this a slower earlier response can land last and
   * paint numbers for a window the user is no longer on — the rendered figures
   * would then disagree with the API for the selected window (validation §6).
   */
  const trendsReq = useRef(0);

  const loadTrends = useCallback(async (w: number) => {
    const seq = ++trendsReq.current;
    try {
      const [nw, cf, inc, cats, bud] = await Promise.all([
        api.getNetWorth(w),
        api.getCashFlow(w),
        api.getIncomeTrend(w),
        api.getCategoryTrend(w),
        api.getBudgetTrend(w),
      ]);
      if (seq !== trendsReq.current) return;
      setNetWorth(nw);
      setCashFlow(cf);
      setIncome(inc);
      setSpending(cats);
      setBudget(bud);
      setError(null);
    } catch (e) {
      if (seq !== trendsReq.current) return;
      setError(e instanceof Error ? e.message : 'failed to load the trends');
    }
  }, []);

  useEffect(() => {
    api
      .getRecurringCommitments()
      .then(setCommitments)
      .catch((e) => setError(e instanceof Error ? e.message : 'failed to load the dashboard'));
  }, []);

  useEffect(() => {
    void loadTrends(window_);
  }, [window_, loadTrends]);

  const partialMonths = netWorth.filter((p) => p.partialAccounts).map((p) => p.month);
  const latest = netWorth.at(-1);
  const windowLabel = `${window_} months`;

  return (
    <div data-testid="dashboard">
      {error && (
        <p role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}

      <HatchDefs
        theme={theme}
        colors={[
          series.income,
          series.expenses,
          series.salary,
          series.otherIncome,
          series.planned,
          series.actual,
          ...SPEND_PALETTE[theme],
          REST_COLOR[theme],
          UNCATEGORIZED_COLOR[theme],
        ]}
      />

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          marginBottom: '1rem',
        }}
      >
        <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>Trend window</span>
        <WindowSelector value={window_} onChange={setWindow} />
      </div>

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
              <button onClick={() => setShowBreakdown((s) => !s)} aria-pressed={showBreakdown} style={smallButton}>
                Breakdown
              </button>
            }
          >
            {latest && (
              <p style={{ fontSize: '1.6rem', margin: '0 0 0.5rem' }}>
                <Money cents={latest.netWorthCents} testId="net-worth-latest" />
              </p>
            )}
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={netWorth} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                <CartesianGrid stroke={chrome.grid} vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: chrome.axis }} stroke={chrome.axis} />
                <YAxis
                  tickFormatter={euroAxis}
                  tick={{ fontSize: 11, fill: chrome.axis }}
                  stroke={chrome.axis}
                  width={56}
                />
                <Tooltip
                  formatter={tooltipFormatter}
                  contentStyle={{
                    background: chrome.tooltipBg,
                    border: `1px solid ${chrome.axis}`,
                    borderRadius: 6,
                  }}
                  labelStyle={{ color: chrome.tooltipText }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line
                  type="monotone"
                  dataKey="netWorthCents"
                  name="Net worth"
                  stroke={series.netWorth}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
                {showBreakdown && (
                  <Line
                    type="monotone"
                    dataKey="accountsCents"
                    name="Accounts"
                    stroke={series.accounts}
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
                    stroke={series.investments}
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
                    stroke={series.loans}
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
          <Card
            title="Cash flow"
            subtitle={[windowLabel, 'transfers excluded', partialNote(cashFlow)]
              .filter(Boolean)
              .join(' · ')}
          >
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={cashFlow} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                <CartesianGrid stroke={chrome.grid} vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: chrome.axis }} stroke={chrome.axis} />
                <YAxis
                  tickFormatter={euroAxis}
                  tick={{ fontSize: 11, fill: chrome.axis }}
                  stroke={chrome.axis}
                  width={56}
                />
                <Tooltip
                  formatter={tooltipFormatter}
                  contentStyle={{
                    background: chrome.tooltipBg,
                    border: `1px solid ${chrome.axis}`,
                    borderRadius: 6,
                  }}
                  labelStyle={{ color: chrome.tooltipText }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="incomeCents" name="Income" fill={series.income} radius={[4, 4, 0, 0]} isAnimationActive={false}>
                  {cashFlow.map((p) => (
                    <Cell key={p.month} fill={fillFor(series.income, p.partial)} />
                  ))}
                </Bar>
                <Bar
                  dataKey="expensesCents"
                  name="Expenses"
                  fill={series.expenses}
                  radius={[4, 4, 0, 0]}
                  isAnimationActive={false}
                >
                  {cashFlow.map((p) => (
                    <Cell key={p.month} fill={fillFor(series.expenses, p.partial)} />
                  ))}
                </Bar>
                <Line
                  type="monotone"
                  dataKey="netCents"
                  name="Net"
                  stroke={series.net}
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
                  data-partial={String(p.partial)}
                />
              ))}
            </ul>
          </Card>
        </div>

        <Card
          title="Income sources"
          subtitle={[windowLabel, partialNote(income)].filter(Boolean).join(' · ')}
        >
          <p style={{ fontSize: '1.3rem', margin: '0 0 0.5rem' }}>
            <Money cents={completeTotal(income, (p) => p.salaryCents + p.otherIncomeCents)} testId="income-total" />
            <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}> total</span>
          </p>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={income} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
              <CartesianGrid stroke={chrome.grid} vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: chrome.axis }} stroke={chrome.axis} />
              <YAxis
                tickFormatter={euroAxis}
                tick={{ fontSize: 11, fill: chrome.axis }}
                stroke={chrome.axis}
                width={56}
              />
              <Tooltip
                formatter={tooltipFormatter}
                contentStyle={{
                  background: chrome.tooltipBg,
                  border: `1px solid ${chrome.axis}`,
                  borderRadius: 6,
                }}
                labelStyle={{ color: chrome.tooltipText }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="salaryCents" stackId="income" name="Salary" fill={series.salary} isAnimationActive={false}>
                {income.map((p) => (
                  <Cell key={p.month} fill={fillFor(series.salary, p.partial)} />
                ))}
              </Bar>
              <Bar
                dataKey="otherIncomeCents"
                stackId="income"
                name="Other income"
                fill={series.otherIncome}
                isAnimationActive={false}
              >
                {income.map((p) => (
                  <Cell key={p.month} fill={fillFor(series.otherIncome, p.partial)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: 0 }}>
            Reimbursements are not income — they reduce the category they sit in.
          </p>
          <ul hidden data-testid="income-series">
            {income.map((p) => (
              <li
                key={p.month}
                data-month={p.month}
                data-salary={p.salaryCents}
                data-other={p.otherIncomeCents}
                data-partial={String(p.partial)}
              />
            ))}
          </ul>
        </Card>

        <Card title="Recurring commitments" subtitle="estimate">
          {commitments && (
            <>
              <p style={{ fontSize: '1.6rem', margin: '0 0 0.25rem' }}>
                ≈ <Money cents={commitments.normalizedMonthlyCents} testId="commitments-total" />
                <span style={{ fontSize: '0.9rem', color: 'var(--muted)' }}> /mo</span>
              </p>
              <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: 0 }}>
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
                      <span style={{ color: 'var(--muted)' }}>
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
          <Card
            title="Spending by category"
            subtitle={[windowLabel, spending && partialNote(spending.months)].filter(Boolean).join(' · ')}
          >
            {spending && (
              <SpendingTrend
                trend={spending}
                theme={theme}
                chrome={chrome}
                onOpenTriage={onOpenTriage}
              />
            )}
          </Card>
        </div>

        <div style={{ gridColumn: '1 / -1' }}>
          <Card
            title="Budget vs. actual"
            subtitle={[windowLabel, partialNote(budget)].filter(Boolean).join(' · ')}
            actions={
              <button onClick={onOpenBudgets} style={smallButton}>
                Open Budgets
              </button>
            }
          >
            <dl
              style={{
                margin: '0 0 0.75rem',
                display: 'grid',
                gridTemplateColumns: 'auto auto 1fr',
                gap: '0.3rem 1rem',
                fontSize: '0.9rem',
              }}
            >
              <dt>Planned</dt>
              <dd style={{ margin: 0, textAlign: 'right' }}>
                <Money cents={completeTotal(budget, (p) => p.plannedCents)} testId="budget-planned" />
              </dd>
              <span />
              <dt>Actual</dt>
              <dd style={{ margin: 0, textAlign: 'right' }}>
                <Money cents={completeTotal(budget, (p) => p.actualCents)} testId="budget-actual" />
              </dd>
              <span />
              <dt>Total spent</dt>
              <dd style={{ margin: 0, textAlign: 'right' }}>
                <Money cents={completeTotal(budget, (p) => p.expenseCents)} testId="budget-expense" />
              </dd>
              <span />
            </dl>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={budget} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                <CartesianGrid stroke={chrome.grid} vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: chrome.axis }} stroke={chrome.axis} />
                <YAxis
                  tickFormatter={euroAxis}
                  tick={{ fontSize: 11, fill: chrome.axis }}
                  stroke={chrome.axis}
                  width={56}
                />
                <Tooltip
                  formatter={tooltipFormatter}
                  contentStyle={{
                    background: chrome.tooltipBg,
                    border: `1px solid ${chrome.axis}`,
                    borderRadius: 6,
                  }}
                  labelStyle={{ color: chrome.tooltipText }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="plannedCents" name="Planned" fill={series.planned} radius={[4, 4, 0, 0]} isAnimationActive={false}>
                  {budget.map((p) => (
                    <Cell key={p.month} fill={fillFor(series.planned, p.partial)} />
                  ))}
                </Bar>
                <Bar dataKey="actualCents" name="Actual" fill={series.actual} radius={[4, 4, 0, 0]} isAnimationActive={false}>
                  {budget.map((p) => (
                    <Cell key={p.month} fill={fillFor(series.actual, p.partial)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            {budget.every((p) => !p.budgeted) && (
              <p style={{ fontSize: '0.75rem', color: 'var(--muted)' }} data-testid="budget-none">
                No category goals set in this window.
              </p>
            )}
            <ul hidden data-testid="budget-series">
              {budget.map((p) => (
                <li
                  key={p.month}
                  data-month={p.month}
                  data-planned={p.plannedCents}
                  data-actual={p.actualCents}
                  data-expense={p.expenseCents}
                  data-materialized={String(p.materialized)}
                  data-partial={String(p.partial)}
                />
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}

/**
 * Spending as stacked monthly bands. The API decides which categories are big
 * enough to chart and collapses the rest, so this only assigns colour and shape.
 */
function SpendingTrend({
  trend,
  theme,
  chrome,
  onOpenTriage,
}: {
  trend: CategoryTrend;
  theme: 'light' | 'dark';
  chrome: (typeof CHROME)[keyof typeof CHROME];
  onOpenTriage: () => void;
}) {
  const colorFor = (key: number | null | 'rest', rank: number): string => {
    if (key === null) return UNCATEGORIZED_COLOR[theme];
    if (key === 'rest') return REST_COLOR[theme];
    return SPEND_PALETTE[theme][rank % SPEND_PALETTE[theme].length]!;
  };

  const data = trend.months.map((m, i) => {
    const row: Record<string, string | number | boolean> = { month: m.month, partial: m.partial };
    for (const s of trend.series) row[String(s.key)] = s.amountsCents[i] ?? 0;
    return row;
  });

  const completeSum = (s: CategoryTrend['series'][number]): number =>
    s.amountsCents.reduce((n, cents, i) => (trend.months[i]!.partial ? n : n + cents), 0);
  const windowTotal = trend.series.reduce((sum, s) => sum + completeSum(s), 0);
  // Uncategorized keeps its needs-review billing here: it is a distinct state
  // from the reviewed catch-all, and the queue that resolves it is one click away.
  const uncategorizedTotal = trend.series
    .filter((s) => s.key === null)
    .reduce((sum, s) => sum + completeSum(s), 0);

  return (
    <>
      <p style={{ fontSize: '1.3rem', margin: '0 0 0.5rem' }}>
        <Money cents={windowTotal} testId="spending-total" />
        <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}> total</span>
      </p>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid stroke={chrome.grid} vertical={false} />
          <XAxis dataKey="month" tick={{ fontSize: 11, fill: chrome.axis }} stroke={chrome.axis} />
          <YAxis
            tickFormatter={euroAxis}
            tick={{ fontSize: 11, fill: chrome.axis }}
            stroke={chrome.axis}
            width={56}
          />
          <Tooltip
            formatter={tooltipFormatter}
            contentStyle={{
              background: chrome.tooltipBg,
              border: `1px solid ${chrome.axis}`,
              borderRadius: 6,
            }}
            labelStyle={{ color: chrome.tooltipText }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {trend.series.map((s, rank) => (
            <Bar
              key={String(s.key)}
              dataKey={String(s.key)}
              stackId="spend"
              name={s.name}
              fill={colorFor(s.key, rank)}
              isAnimationActive={false}
            >
              {data.map((row) => (
                <Cell
                  key={String(row.month)}
                  fill={fillFor(colorFor(s.key, rank), row.partial === true)}
                />
              ))}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
      {uncategorizedTotal !== 0 && (
        <p style={{ fontSize: '0.8rem', margin: '0.25rem 0 0' }} data-testid="spending-needs-review">
          <Money cents={uncategorizedTotal} testId="spending-uncategorized" /> of this is
          uncategorized and needs review.{' '}
          <button onClick={onOpenTriage} style={{ ...smallButton, marginLeft: '0.25rem' }}>
            Sort it out
          </button>
        </p>
      )}
      <ul hidden data-testid="category-trend-series">
        {trend.series.map((s) => (
          <li
            key={String(s.key)}
            data-key={String(s.key)}
            data-name={s.name}
            data-amounts={s.amountsCents.join(',')}
          />
        ))}
      </ul>
      <ul hidden data-testid="category-trend-months">
        {trend.months.map((m) => (
          <li key={m.month} data-month={m.month} data-partial={String(m.partial)} />
        ))}
      </ul>
    </>
  );
}
