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
 * The seed deliberately ships no budgets (an envelope must exist only because
 * the owner set one, 003-K), so the budget-vs-actual card would otherwise render
 * its empty state and criterion 10's tie-out for that card would assert nothing.
 * Materializing here is idempotent, so every test that needs the card can call it.
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
  cashFlow: { month: string; incomeCents: number; expensesCents: number; netCents: number }[];
  income: { salaryCents: number; otherIncomeCents: number };
  categories: { categoryId: number | null; amountCents: number }[];
  budget: { materialized: boolean; totals: { plannedCents: number; actualCents: number; expenseCents: number } };
  commitments: { normalizedMonthlyCents: number; byTemplate: { templateId: number; monthlyEquivalentCents: number }[] };
};

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
    income: await json(`/dashboard/income?month=${MONTH}`),
    categories: await json(`/dashboard/categories?month=${MONTH}`),
    budget: await json(`/dashboard/budget-vs-actual?month=${MONTH}`),
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
  }

  // --- Income sources -------------------------------------------------------
  expect(await cents(page.getByTestId('income-salary'))).toBe(api.income.salaryCents);
  expect(await cents(page.getByTestId('income-other'))).toBe(api.income.otherIncomeCents);

  // --- Category breakdown ---------------------------------------------------
  for (const entry of api.categories) {
    const row = page.getByTestId(`category-${entry.categoryId ?? 'uncategorized'}`);
    expect(await cents(row), `category ${entry.categoryId}`).toBe(entry.amountCents);
  }
  // ...and the rendered rows sum to the cash-flow expense total for the month.
  const rendered = await page
    .getByTestId('category-breakdown')
    .locator('li')
    .evaluateAll((nodes) => nodes.map((n) => Number(n.getAttribute('data-cents'))));
  expect(rendered.reduce((s, n) => s + n, 0)).toBe(
    api.cashFlow.find((p) => p.month === MONTH)!.expensesCents,
  );

  // --- Budget vs actual -----------------------------------------------------
  // Asserted unconditionally: `ensureBudget` above guarantees the month is
  // materialized, so a card that silently stopped rendering cannot pass by
  // skipping these.
  expect(api.budget.materialized).toBe(true);
  expect(await cents(page.getByTestId('budget-planned'))).toBe(api.budget.totals.plannedCents);
  expect(await cents(page.getByTestId('budget-actual'))).toBe(api.budget.totals.actualCents);
  expect(await cents(page.getByTestId('budget-expense'))).toBe(api.budget.totals.expenseCents);

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
  await expect(page.getByTestId('income-salary')).toBeVisible();
  await expect(page.getByTestId('commitments-total')).toBeVisible();
  await expect(page.getByTestId('category-breakdown').locator('li').first()).toBeVisible();
  await expect(page.getByTestId('asset-entry').locator('li')).toHaveCount(2);
  await expect(page.getByTestId('budget-planned')).toBeVisible();
  await expect(page.getByTestId('budget-expense')).toBeVisible();

  // Uncategorized is its own slice, marked for review.
  await expect(page.getByTestId('category-uncategorized')).toContainText('needs review');
  // The commitments tile is labelled an estimate.
  await expect(page.getByText(/An estimate/)).toBeVisible();

  // Show the breakdown so the screenshot carries all three net-worth series.
  await page.getByRole('button', { name: 'Breakdown' }).click();
  await expect(page.getByText('Investments')).toBeVisible();

  await page.screenshot({ path: 'test-results/dashboard.png', fullPage: true });
});

/**
 * 004-F, through the UI. Backing out of the archive prompt must leave the asset
 * alone: archiving a still-carrying loan strands its balance in net worth for
 * every future month, and the form never shows an archived asset again, so a
 * fall-through on "cancel" is unrecoverable without hand-editing the DB.
 *
 * Runs last and restores what it changed — the seeded server is reused between
 * local runs, so leaving an asset archived would break the count assertions above.
 */
test('004-F: cancelling the archive prompt leaves the asset untouched; closing at 0 archives it', async ({
  page,
  request,
}) => {
  const base = 'http://127.0.0.1:3001/api';
  const before = (await (await request.get(`${base}/asset-snapshots?month=${MONTH}`)).json()) as {
    assetId: number;
    name: string;
    valueCents: number | null;
  }[];
  const loan = before.find((e) => e.name === 'Car loan')!;
  expect(loan.valueCents, 'the loan must be carrying for this test to mean anything').toBeGreaterThan(0);
  const netWorthAt = async (month: string): Promise<number> => {
    const points = (await (
      await request.get(`${base}/dashboard/net-worth?window=12`)
    ).json()) as Api['netWorth'];
    return points.find((p) => p.month === month)!.netWorthCents;
  };
  const netWorthBefore = await netWorthAt(MONTH);

  await page.goto('/');
  await page.getByRole('button', { name: 'Dashboard' }).click();
  await expect(page.getByTestId('asset-entry').locator('li')).toHaveCount(2);

  // --- Cancel must not archive ---------------------------------------------
  await page.getByTestId(`archive-${loan.assetId}`).click();
  await expect(page.getByTestId('archive-confirm')).toBeVisible();
  await page.getByTestId('archive-cancel').click();
  await expect(page.getByTestId('archive-confirm')).toBeHidden();
  await expect(page.getByTestId('asset-entry').locator('li')).toHaveCount(2);

  // The API agrees: still listed, still carrying its original value.
  const afterCancel = (await (
    await request.get(`${base}/asset-snapshots?month=${MONTH}`)
  ).json()) as typeof before;
  expect(afterCancel.find((e) => e.assetId === loan.assetId)?.valueCents).toBe(loan.valueCents);
  expect(await netWorthAt(MONTH), 'cancelling must not move net worth').toBe(netWorthBefore);

  // --- Close at 0, then archive --------------------------------------------
  await page.getByTestId(`archive-${loan.assetId}`).click();
  await page.getByTestId('archive-zero-first').click();
  await expect(page.getByTestId('asset-entry').locator('li')).toHaveCount(1);

  // The closing 0 landed BEFORE the archive, so the loan stops subtracting and
  // net worth rises by exactly its balance — the 004-F "no phantom loan" result.
  expect(await netWorthAt(MONTH)).toBe(netWorthBefore + loan.valueCents!);

  // --- Restore the seed ------------------------------------------------------
  await request.patch(`${base}/assets/${loan.assetId}`, { data: { archived: false } });
  await request.put(`${base}/asset-snapshots`, {
    data: { month: MONTH, values: [{ assetId: loan.assetId, valueCents: loan.valueCents }] },
  });
});
