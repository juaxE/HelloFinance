import { expect, test } from '@playwright/test';

/**
 * Proposal 008 criterion 6/7 — resuming an interrupted review.
 *
 * The seed (`npm run seed:test`) leaves the overlap fixture in `pending_review`
 * on Main: 42 rows, 28 duplicates, 14 new across 10 groups. This spec reads it
 * and MUST NEITHER COMMIT NOR DISCARD IT — `workers: 1` means every later spec
 * shares this database, and committing would move the dashboard figures they
 * assert. Labeling a staged group is safe: nothing reaches `transactions` until
 * a commit that never happens here.
 *
 * The import id is never hardcoded — it is found through the list endpoint,
 * which is the feature under test.
 */
const PENDING_FILENAME = 'overlap-2026-06_2026-07.csv';

test('criterion 6: a pending import is listed and resumes with its staged decisions intact', async ({
  page,
}) => {
  await page.goto('/');

  // `review-screen.spec.ts` uploads the same file and leaves it pending too, so
  // this must not assert a count: after a full suite run — or a re-run of this
  // spec alone against an already-exercised database — there are several rows
  // with this filename. The list is newest-first, so the seeded one is last.
  const row = page.getByTestId('pending-import-row').filter({ hasText: PENDING_FILENAME }).last();
  await expect(row).toBeVisible();
  await expect(row).toContainText('Main');
  await expect(row).toContainText('14 new, 28 duplicates');

  await page.screenshot({ path: 'test-results/import-pending-list.png', fullPage: true });

  await row.getByRole('button', { name: 'Resume' }).click();

  await expect(page.getByRole('heading', { name: 'Review import' })).toBeVisible();
  await expect(page.getByTestId('import-summary')).toContainText('14 new, 28 duplicates skipped');
  await expect(page.getByTestId('group-card')).toHaveCount(10);

  // Label a group, then leave the page the way an interrupted review does.
  const card = page.getByTestId('group-card').first();
  const select = card.getByRole('combobox').first();
  await select.selectOption({ label: 'Groceries' });
  await card.getByRole('button', { name: /^Apply to all/ }).click();
  await expect(select.locator('option:checked')).toHaveText('Groceries');

  await page.reload();

  const rowAgain = page
    .getByTestId('pending-import-row')
    .filter({ hasText: PENDING_FILENAME })
    .last();
  await rowAgain.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByRole('heading', { name: 'Review import' })).toBeVisible();

  const cardAgain = page.getByTestId('group-card').first();
  await expect(cardAgain.getByRole('combobox').first().locator('option:checked')).toHaveText(
    'Groceries',
  );

  await page.screenshot({ path: 'test-results/import-resumed.png', fullPage: true });
});

test('criterion 7: with no pending imports the import page is unchanged', async ({ page }) => {
  // Served empty rather than emptied for real: discarding the seeded import
  // would break every later spec (see the file header).
  await page.route('**/api/imports?status=pending_review', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );

  await page.goto('/');

  await expect(page.getByTestId('pending-imports')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Import a CSV export' })).toBeVisible();
  await expect(page.getByLabel('Account')).toBeVisible();
  await expect(page.getByLabel('CSV file')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Analyze' })).toBeDisabled();
});

// The listed row is a snapshot. Another tab — the very situation resume exists
// for — can commit or discard an import between the list load and the click,
// and the review screen must not open on staging that no longer exists.
test('resuming an import that is no longer pending reports it instead of opening the review', async ({
  page,
}) => {
  await page.goto('/');
  const row = page.getByTestId('pending-import-row').filter({ hasText: PENDING_FILENAME }).last();
  await expect(row).toBeVisible();

  // Answer the detail fetch as the other tab would have left it. Read-only:
  // the seeded import is untouched on the server.
  await page.route(/\/api\/imports\/\d+$/, async (route) => {
    const detail = await route.fetch().then((r) => r.json());
    await route.fulfill({ json: { ...detail, status: 'committed' } });
  });

  await row.getByRole('button', { name: 'Resume' }).click();

  await expect(page.getByRole('alert')).toContainText('no longer in review');
  await expect(page.getByRole('heading', { name: 'Review import' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Import a CSV export' })).toBeVisible();
});
