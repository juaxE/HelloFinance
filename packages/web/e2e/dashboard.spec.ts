import { expect, test } from '@playwright/test';

/**
 * Spec 004 criteria 10 and 11, against the seeded dataset (`npm run seed:test`)
 * with the server's "today" pinned to 2026-06-15 by `FINANCE_NOW` (see
 * playwright.config.ts), so the current-month cards land inside the fixture span.
 *
 * The tie-out compares at the **cents** level: the DOM carries raw integer cents
 * in `data-cents` / `data-*` attributes, and those are checked against the API
 * responses. String-comparing rendered text against `formatEur` output would be
 * a tautology — it would pass even if both sides were wrong.
 */

// These tests mutate shared server state (the seeded DB): the budget month below
// is materialized and given an envelope. Running them in parallel against one
// server lets one test's writes land mid-read in another, so they are serial —
// same reason and same convention as budgets.spec.ts.
test.describe.configure({ mode: 'serial' });

const MONTH = '2026-06';

/**
 * The seed ships envelopes only in the two closed months it plants as history
 * (2026-04, 2026-05) — an envelope must exist only because the owner set one
 * (003-K) — so the current month's budget-vs-actual card would otherwise render
 * its empty state and criterion 10's tie-out for that card would assert nothing.
 * Materializing here is idempotent, so every test that needs the card can call
 * it. MONTH is the pinned current month, which is what makes these writes legal
 * at all (proposal 007).
 */
async function ensureBudget(request: import('@playwright/test').APIRequestContext): Promise<void> {
  await request.post('http://127.0.0.1:3001/api/budgets', { data: { month: MONTH } });
  const categories = (await (
    await request.get('http://127.0.0.1:3001/api/categories')
  ).json()) as { id: number; name: string }[];
  const groceries = categories.find((c) => c.name === 'Groceries')!;
  await request.put(`http://127.0.0.1:3001/api/budgets/${MONTH}/envelopes`, {
    data: { envelopes: [{ categoryId: groceries.id, amountCents: 45000 }] },
  });
}

type Api = {
  netWorth: { month: string; netWorthCents: number; accountsCents: number; investmentsCents: number; loansCents: number; partialAccounts: boolean }[];
  cashFlow: { month: string; incomeCents: number; expensesCents: number; netCents: number; partial: boolean }[];
  income: { month: string; salaryCents: number; otherIncomeCents: number; partial: boolean }[];
  spending: {
    months: { month: string; partial: boolean }[];
    series: { key: number | null | 'rest'; name: string; amountsCents: number[] }[];
  };
  budget: {
    month: string;
    materialized: boolean;
    plannedCents: number;
    actualCents: number;
    expenseCents: number;
    partial: boolean;
  }[];
  commitments: { normalizedMonthlyCents: number; byTemplate: { templateId: number; monthlyEquivalentCents: number }[] };
};

/** A flow figure the dashboard shows: summed over COMPLETE months only. */
function completeTotal<T extends { partial: boolean }>(points: T[], value: (p: T) => number): number {
  return points.filter((p) => !p.partial).reduce((sum, p) => sum + value(p), 0);
}

async function readApi(request: import('@playwright/test').APIRequestContext): Promise<Api> {
  const base = 'http://127.0.0.1:3001/api';
  const json = async (path: string) => {
    const res = await request.get(`${base}${path}`);
    expect(res.ok(), `${path} -> ${res.status()}`).toBeTruthy();
    return res.json();
  };
  return {
    netWorth: await json('/dashboard/net-worth?window=12'),
    cashFlow: await json('/dashboard/cash-flow?window=12'),
    income: await json('/dashboard/income-trend?window=12'),
    spending: await json('/dashboard/category-trend?window=12'),
    budget: await json('/dashboard/budget-trend?window=12'),
    commitments: await json('/dashboard/recurring-commitments'),
  };
}

/** Read a `data-*` attribute off a locator as an integer. */
async function cents(locator: import('@playwright/test').Locator, attr = 'data-cents'): Promise<number> {
  const raw = await locator.getAttribute(attr);
  expect(raw, `missing ${attr}`).not.toBeNull();
  return Number(raw);
}

test('criterion 10: every number rendered on the dashboard equals the API response, at cents precision', async ({
  page,
  request,
}) => {
  await ensureBudget(request);
  const api = await readApi(request);

  await page.goto('/');
  await page.getByRole('button', { name: 'Dashboard' }).click();
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await expect(page.getByTestId('net-worth-latest')).toBeVisible();

  // --- Net worth: the headline and every point of the series ---------------
  const latest = api.netWorth.at(-1)!;
  expect(await cents(page.getByTestId('net-worth-latest'))).toBe(latest.netWorthCents);

  const points = page.getByTestId('net-worth-series').locator('li');
  await expect(points).toHaveCount(api.netWorth.length);
  for (const [i, point] of api.netWorth.entries()) {
    const row = points.nth(i);
    expect(await row.getAttribute('data-month')).toBe(point.month);
    expect(await cents(row)).toBe(point.netWorthCents);
    expect(await cents(row, 'data-accounts')).toBe(point.accountsCents);
    expect(await cents(row, 'data-investments')).toBe(point.investmentsCents);
    expect(await cents(row, 'data-loans')).toBe(point.loansCents);
    expect(await row.getAttribute('data-partial')).toBe(String(point.partialAccounts));
  }

  // --- Cash flow ------------------------------------------------------------
  const bars = page.getByTestId('cash-flow-series').locator('li');
  await expect(bars).toHaveCount(api.cashFlow.length);
  for (const [i, point] of api.cashFlow.entries()) {
    const row = bars.nth(i);
    expect(await row.getAttribute('data-month')).toBe(point.month);
    expect(await cents(row, 'data-income')).toBe(point.incomeCents);
    expect(await cents(row, 'data-expenses')).toBe(point.expensesCents);
    expect(await cents(row, 'data-net')).toBe(point.netCents);
    expect(await row.getAttribute('data-partial')).toBe(String(point.partial));
  }

  // --- Income sources -------------------------------------------------------
  // The headline is the window total over COMPLETE months; the month in
  // progress is charted but must not be added in.
  expect(await cents(page.getByTestId('income-total'))).toBe(
    completeTotal(api.income, (p) => p.salaryCents + p.otherIncomeCents),
  );
  const incomeRows = page.getByTestId('income-series').locator('li');
  await expect(incomeRows).toHaveCount(api.income.length);
  for (const [i, point] of api.income.entries()) {
    const row = incomeRows.nth(i);
    expect(await row.getAttribute('data-month')).toBe(point.month);
    expect(await cents(row, 'data-salary')).toBe(point.salaryCents);
    expect(await cents(row, 'data-other')).toBe(point.otherIncomeCents);
    expect(await row.getAttribute('data-partial')).toBe(String(point.partial));
  }

  // --- Spending by category -------------------------------------------------
  const spendRows = page.getByTestId('category-trend-series').locator('li');
  await expect(spendRows).toHaveCount(api.spending.series.length);
  for (const [i, s] of api.spending.series.entries()) {
    const row = spendRows.nth(i);
    expect(await row.getAttribute('data-key')).toBe(String(s.key));
    expect(await row.getAttribute('data-name')).toBe(s.name);
    expect(await row.getAttribute('data-amounts')).toBe(s.amountsCents.join(','));
  }

  const spendMonths = page.getByTestId('category-trend-months').locator('li');
  await expect(spendMonths).toHaveCount(api.spending.months.length);
  for (const [i, m] of api.spending.months.entries()) {
    expect(await spendMonths.nth(i).getAttribute('data-partial')).toBe(String(m.partial));
  }

  // The headline sums every band over the complete months...
  const spendingTotal = api.spending.series.reduce(
    (sum, s) =>
      sum + s.amountsCents.reduce((n, c, i) => (api.spending.months[i]!.partial ? n : n + c), 0),
    0,
  );
  expect(await cents(page.getByTestId('spending-total'))).toBe(spendingTotal);
  // ...and that equals cash flow's expense total over the same complete months,
  // which is the M tie-out holding across two independently computed endpoints.
  expect(spendingTotal).toBe(completeTotal(api.cashFlow, (p) => p.expensesCents));

  // --- Budget vs actual -----------------------------------------------------
  // Asserted unconditionally: `ensureBudget` above guarantees the month is
  // materialized, so a card that silently stopped rendering cannot pass by
  // skipping these.
  expect(api.budget.some((p) => p.materialized)).toBe(true);
  expect(await cents(page.getByTestId('budget-planned'))).toBe(
    completeTotal(api.budget, (p) => p.plannedCents),
  );
  expect(await cents(page.getByTestId('budget-actual'))).toBe(
    completeTotal(api.budget, (p) => p.actualCents),
  );
  expect(await cents(page.getByTestId('budget-expense'))).toBe(
    completeTotal(api.budget, (p) => p.expenseCents),
  );

  // --- Commitments ----------------------------------------------------------
  expect(await cents(page.getByTestId('commitments-total'))).toBe(
    api.commitments.normalizedMonthlyCents,
  );
  await page.getByRole('group', { name: 'Trend window' }).waitFor();
  await page.getByText(/Per template/).click();
  for (const template of api.commitments.byTemplate) {
    expect(await cents(page.getByTestId(`commitment-${template.templateId}-monthly`))).toBe(
      template.monthlyEquivalentCents,
    );
  }
});

test('criterion 10: the window selector re-reads the API and the DOM still ties out', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Dashboard' }).click();
  await expect(page.getByTestId('net-worth-latest')).toBeVisible();

  await page.getByRole('button', { name: '3m' }).click();

  const res = await request.get('http://127.0.0.1:3001/api/dashboard/net-worth?window=3');
  const expected = (await res.json()) as Api['netWorth'];
  const points = page.getByTestId('net-worth-series').locator('li');
  await expect(points).toHaveCount(expected.length);
  for (const [i, point] of expected.entries()) {
    expect(await cents(points.nth(i))).toBe(point.netWorthCents);
  }
});

test('criterion 11: the dashboard renders with seeded data visible in every card', async ({
  page,
  request,
}) => {
  await ensureBudget(request);

  await page.goto('/');
  await page.getByRole('button', { name: 'Dashboard' }).click();
  await expect(page.getByTestId('dashboard')).toBeVisible();

  // Every card has real seeded data in it, not an empty state.
  await expect(page.getByTestId('net-worth-latest')).toBeVisible();
  await expect(page.getByTestId('income-total')).toBeVisible();
  await expect(page.getByTestId('commitments-total')).toBeVisible();
  await expect(page.getByTestId('spending-total')).toBeVisible();
  await expect(page.getByTestId('budget-planned')).toBeVisible();
  await expect(page.getByTestId('budget-expense')).toBeVisible();

  // Uncategorized keeps its needs-review billing and routes to the triage queue.
  await expect(page.getByTestId('spending-needs-review')).toContainText('needs review');
  await page.getByRole('button', { name: 'Sort it out' }).click();
  await expect(page.getByTestId('triage')).toBeVisible();
  await page.getByRole('button', { name: 'Dashboard' }).click();

  // The month in progress is labelled as such rather than compared like a full one.
  await expect(page.getByText(/2026-06 still in progress/).first()).toBeVisible();
  // The commitments tile is labelled an estimate.
  await expect(page.getByText(/An estimate/)).toBeVisible();

  // Show the breakdown so the screenshot carries all three net-worth series.
  await page.getByRole('button', { name: 'Breakdown' }).click();
  await expect(page.getByText('Investments')).toBeVisible();

  await page.screenshot({ path: 'test-results/dashboard.png', fullPage: true });
});
