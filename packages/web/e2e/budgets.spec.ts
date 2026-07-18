import { expect, test } from '@playwright/test';

/**
 * Spec 003 criterion 27 — the two required screenshots, taken against the
 * seeded dataset (`npm run seed:test`): a year of committed history plus five
 * recurring templates, and deliberately **no** envelopes, since an envelope
 * must exist only because the owner set one (decision 003-K).
 *
 * Every month used holds real fixture charges; 2026-04 additionally holds the
 * uncategorized +10,12 EUR VIPPS payback that criterion 11's "Needs review"
 * bucket is about.
 */

// These tests share one seeded database, and envelopes are persistent state, so
// each test owns a distinct month pair and the file runs serially. 2026-04 is
// reserved for the reconciliation screenshot because it holds the uncategorized
// VIPPS payback.
test.describe.configure({ mode: 'serial' });

const SUGGESTION_PREVIOUS = '2025-08';
const SUGGESTION_MONTH = '2025-09';
const UNTOUCHED_PREVIOUS = '2025-10';
const UNTOUCHED_MONTH = '2025-11';
const RECONCILED_MONTH = '2026-04';

/** The goal input itself — its aria-label is a prefix of the confirm button's. */
function goalInput(page: import('@playwright/test').Page, category: string) {
  return page.getByRole('textbox', { name: `Goal for ${category}`, exact: true });
}

async function openBudgets(page: import('@playwright/test').Page, month: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Budgets' }).click();
  const picker = page.getByRole('textbox', { name: 'Month', exact: true });
  await picker.fill(month);
  await picker.blur();

  // Wait for the load to settle into one of its two terminal states before
  // deciding: a month is NOT materialized just by navigating to it (003-C), so
  // an absent month shows the uncreated marker until we ask for it.
  const heading = page.getByRole('heading', { name: month, exact: true });
  const uncreated = page.getByTestId('month-uncreated');
  await expect(heading.or(uncreated).first()).toBeVisible();

  if (await uncreated.isVisible()) {
    await page.getByRole('button', { name: 'Materialize month' }).click();
  }
  await expect(heading).toBeVisible();
}

test('budget-making screen renders suggestions distinctly from confirmed amounts (criterion 27a)', async ({
  page,
}) => {
  // Give the PREVIOUS month envelopes, so the next month has something to suggest.
  await openBudgets(page, SUGGESTION_PREVIOUS);
  await page.getByRole('button', { name: 'Edit goals' }).click();
  await goalInput(page, 'Groceries').fill('400.00');
  await goalInput(page, 'Transport').fill('120.00');
  await page.getByTestId('save-goals').click();
  await expect(page.getByTestId('group-envelopes')).toBeVisible();

  // Now open the month under test and edit its goals: Groceries and Transport
  // arrive as suggestions; every other category is blank.
  await openBudgets(page, SUGGESTION_MONTH);
  await page.getByRole('button', { name: 'Edit goals' }).click();

  const groceries = goalInput(page, 'Groceries');
  await expect(groceries).toHaveAttribute('data-suggestion', 'true');
  await expect(groceries).toHaveValue('400.00');

  // Click-to-confirm promotes it without retyping...
  await page
    .getByRole('button', { name: 'Confirm suggested goal for Groceries' })
    .click();
  await expect(groceries).toHaveAttribute('data-suggestion', 'false');

  // ...while Transport stays an unconfirmed suggestion, and Health is a
  // deliberately empty category — neither is styled as a problem.
  await expect(goalInput(page, 'Transport')).toHaveAttribute('data-suggestion', 'true');
  await expect(goalInput(page, 'Health')).toHaveValue('');

  // Criterion 22 (UI half): the per-category planned subtotal is envelope +
  // named lines in that category, so double-planning is visible at a glance.
  // Housing carries the seeded 1 180,00 EUR Rent bill and no goal yet.
  const housingRow = page.getByTestId('goal-row').filter({ hasText: 'Housing' });
  await expect(housingRow.getByTestId('planned-subtotal')).toHaveText('1 180,00 €');
  await goalInput(page, 'Housing').fill('200.00');
  // ...and typing a goal adds to the bill rather than replacing it.
  await expect(housingRow.getByTestId('planned-subtotal')).toHaveText('1 380,00 €');

  await page.screenshot({ path: 'test-results/budget-making-screen.png', fullPage: true });
});

test('an untouched suggestion creates no envelope (criterion 20, through the UI)', async ({
  page,
}) => {
  await openBudgets(page, UNTOUCHED_PREVIOUS);
  await page.getByRole('button', { name: 'Edit goals' }).click();
  await goalInput(page, 'Groceries').fill('400.00');
  await page.getByTestId('save-goals').click();

  await openBudgets(page, UNTOUCHED_MONTH);
  await page.getByRole('button', { name: 'Edit goals' }).click();
  await expect(goalInput(page, 'Groceries')).toHaveValue('400.00');
  // Save without touching anything: the suggestion must not become a line.
  await page.getByTestId('save-goals').click();

  const envelopes = page.getByTestId('group-envelopes');
  await expect(envelopes).toHaveCount(0);
  await expect(page.getByTestId('not-budgeted')).toBeVisible();
});

test('month view shows reconciled numbers, the needs-review bucket and the tie-out (criterion 27b)', async ({
  page,
}) => {
  await openBudgets(page, RECONCILED_MONTH);
  await page.getByRole('button', { name: 'Edit goals' }).click();
  await goalInput(page, 'Groceries').fill('400.00');
  await goalInput(page, 'Restaurants & Cafés').fill('150.00');
  await page.getByTestId('save-goals').click();

  // Bills materialized from the seeded templates, reconciled against real charges.
  await expect(page.getByTestId('group-bills')).toBeVisible();
  await expect(page.getByTestId('group-envelopes')).toBeVisible();

  // The uncategorized VIPPS payback shows in Needs review with a POSITIVE
  // amount — the bucket must not render it as spending.
  const needsReview = page.getByTestId('needs-review');
  await expect(needsReview).toBeVisible();
  await expect(needsReview).toContainText('VIPPS MOBILEPAY AS');
  await expect(needsReview).toContainText('10,12 €');

  // The tie-out must reconcile exactly — a mismatch is a critical finding.
  await expect(page.getByTestId('tie-out')).toContainText('reconciles exactly');

  await page.screenshot({ path: 'test-results/budget-month-view.png', fullPage: true });
});
