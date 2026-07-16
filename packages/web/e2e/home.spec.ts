import { expect, test } from '@playwright/test';

test('home page renders the app shell', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'HelloFinance' })).toBeVisible();
});
