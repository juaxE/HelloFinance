import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const OVERLAP_FIXTURE = resolve(HERE, '../../../fixtures/synthetic/overlap-2026-06_2026-07.csv');
const GAP_FIXTURE = resolve(HERE, '../../../fixtures/synthetic/gap-2025-02_2025-03.csv');

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

// The gap fixture ends 2025-03, before Main's 2025-07-01 opening date, so every
// row is before-opening AND the file does not bridge the gap — the 002-E assist
// must NOT be offered; the UI shows the manual-entry fallback instead (AC 002-12).
test('review screen offers manual-entry fallback (not Extend History) for a gap file (AC 002-12)', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Account').selectOption({ label: 'Main' });
  await page.getByLabel('CSV file').setInputFiles(GAP_FIXTURE);
  await page.getByRole('button', { name: 'Analyze' }).click();

  await expect(page.getByRole('heading', { name: 'Review import' })).toBeVisible();
  await expect(page.getByText(/3 rows dated before the account/)).toBeVisible();
  await expect(page.getByTestId('extend-unavailable')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Extend history to include them' })).toHaveCount(0);

  await page.screenshot({ path: 'test-results/review-screen-gap.png', fullPage: true });
});
