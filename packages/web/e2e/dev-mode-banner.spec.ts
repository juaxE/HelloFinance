import { expect, test } from '@playwright/test';

/**
 * Proposal 005 criterion 7. The suite always runs in dev mode (the setup
 * project gates on it), so the banner is unconditionally expected — its absence
 * means either the mode plumbing broke or the suite is pointed at a real
 * database, and both deserve a red test.
 *
 * It lives in the app shell rather than on a page, so it is asserted on several
 * views: the point is that it cannot be navigated away from.
 */
const VIEWS = ['import', 'dashboard', 'transactions', 'budgets', 'assets', 'rules'] as const;

test('the synthetic-data banner is present on every view', async ({ page }) => {
  await page.goto('/');

  const banner = page.getByTestId('dev-mode-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('not your finances');
  await expect(banner).toContainText('data/dev.db');

  for (const view of VIEWS) {
    await page.getByTestId(`nav-${view}`).click();
    await expect(page.getByTestId(`nav-${view}`)).toHaveAttribute('aria-current', 'true');
    await expect(banner, `banner missing on the ${view} view`).toBeVisible();
  }

  await page.getByTestId('nav-dashboard').click();
  await expect(banner).toBeVisible();
  await page.screenshot({ path: 'test-results/dev-mode-banner.png', fullPage: false });
});

/**
 * The banner must fail CLOSED. If `/health` cannot be reached the UI does not
 * know which database it is attached to, and silently rendering no banner would
 * remove the warning exactly when the check that produces it broke — a UI that
 * looks safe because the guard failed.
 */
test('an unreachable /health warns rather than falling silent', async ({ page }) => {
  await page.route('**/health', (route) => route.abort());
  await page.goto('/');

  await expect(page.getByTestId('mode-unknown-banner')).toBeVisible();
  await expect(page.getByTestId('mode-unknown-banner')).toContainText('Do not import');
  await expect(page.getByTestId('dev-mode-banner')).toHaveCount(0);
});
