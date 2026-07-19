import { expect, test } from '@playwright/test';

/**
 * Triage against the seeded dataset (`npm run seed:test`): Main commits its year
 * of history with `allowUncategorized`, leaving 288 uncategorized rows in 28
 * groups — 22 repeat counterparties and 6 seen once each.
 *
 * This spec MUTATES the shared seed, so it applies and then undoes, leaving the
 * database as it found it. The undo half is not decoration: it is the decline
 * path for the apply flow, and the reason applying is safe without a
 * confirmation dialog.
 */

test('triage bunches uncategorized transactions and a rule apply is reversible', async ({ page }) => {
  await page.goto('/');

  // The nav entry carries the backlog size and is absent when there is none.
  const navTriage = page.getByTestId('nav-triage');
  await expect(navTriage).toContainText('Triage (288)');
  await navTriage.click();

  await expect(page.getByTestId('triage-summary')).toContainText('288 transactions in 28 groups');

  // Biggest group first, and the store-number variants collapsed into one.
  const alepa = page.getByTestId('triage-group-ALEPA');
  await expect(alepa).toContainText('46 transactions');
  await expect(alepa).toContainText('-986,93 €');

  // Singletons are split out and offered no rule.
  await expect(page.getByRole('heading', { name: 'One at a time' })).toBeVisible();
  await expect(page.getByTestId('triage-singleton-STEAM GAMES')).toBeVisible();

  await page.screenshot({ path: 'test-results/triage-queue.png', fullPage: true });

  await alepa.getByLabel('Category for ALEPA').selectOption({ label: 'Groceries' });
  await page.getByTestId('triage-remember-ALEPA').click();

  const undoBar = page.getByTestId('triage-undo-bar');
  await expect(undoBar).toContainText('Categorized 46 as Groceries, and remembered the rule');
  await expect(page.getByTestId('triage-summary')).toContainText('242 transactions');
  await expect(navTriage).toContainText('Triage (242)');
  await expect(page.getByTestId('triage-group-ALEPA')).toHaveCount(0);

  await page.screenshot({ path: 'test-results/triage-applied.png', fullPage: true });

  // The rule the apply remembered is real and reachable.
  await page.getByTestId('nav-rules').click();
  await expect(page.getByText('ALEPA', { exact: true })).toBeVisible();

  // Undo puts all 46 rows back AND removes the rule it created.
  await page.getByTestId('nav-triage').click();
  await page.getByTestId('triage-undo').click();

  await expect(page.getByTestId('triage-summary')).toContainText('288 transactions in 28 groups');
  await expect(page.getByTestId('triage-group-ALEPA')).toContainText('46 transactions');
  await expect(navTriage).toContainText('Triage (288)');

  await page.getByTestId('nav-rules').click();
  await expect(page.getByText('ALEPA', { exact: true })).toHaveCount(0);
});

test('a single uncategorized transaction is categorized on its own, without a rule', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('nav-triage').click();

  const singleton = page.getByTestId('triage-singleton-STEAM GAMES');
  await singleton.getByLabel('Category for STEAM GAMES').selectOption({ label: 'Other' });
  await singleton.getByRole('button', { name: 'Apply' }).click();

  await expect(page.getByTestId('triage-undo-bar')).toContainText('Categorized 1 as Other');
  await expect(page.getByTestId('triage-undo-bar')).not.toContainText('remembered the rule');
  await expect(page.getByTestId('nav-triage')).toContainText('Triage (287)');

  // Restore the seed for the specs that follow.
  await page.getByTestId('triage-undo').click();
  await expect(page.getByTestId('nav-triage')).toContainText('Triage (288)');
});
