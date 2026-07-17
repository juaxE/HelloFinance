import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const OVERLAP_FIXTURE = resolve(HERE, '../../../fixtures/synthetic/overlap-2026-06_2026-07.csv');

// Against the seeded dataset (npm run seed:test): Main + Buffer already hold
// a year of committed history, so uploading the overlap fixture here
// reproduces the exact dedup case from fixtures/expected.json (AC 002-3):
// 42 rows, 28 duplicates, 14 new across 10 normalized-counterparty groups.
test('review screen shows groups and duplicate count for a real upload (AC 002-12)', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'HelloFinance' })).toBeVisible();

  await page.getByLabel('Account').selectOption({ label: 'Main' });
  await page.getByLabel('CSV file').setInputFiles(OVERLAP_FIXTURE);
  await page.getByRole('button', { name: 'Analyze' }).click();

  await expect(page.getByRole('heading', { name: 'Review import' })).toBeVisible();
  const summary = page.getByTestId('import-summary');
  await expect(summary).toContainText('14 new');
  await expect(summary).toContainText('28 duplicates skipped');
  await expect(summary).toContainText('encoding: utf-8');

  const groupCards = page.getByTestId('group-card');
  await expect(groupCards).toHaveCount(10);

  await page.getByText(/Duplicates \(28, not imported\)/).click();

  await page.screenshot({ path: 'test-results/review-screen.png', fullPage: true });
});
