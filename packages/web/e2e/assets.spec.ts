import { expect, test } from '@playwright/test';

/**
 * The Assets tab, against the seeded dataset (`npm run seed:test`) with the
 * server's "today" pinned to 2026-06-15 by `FINANCE_NOW`.
 *
 * These tests write to the shared seeded DB and restore what they change —
 * there is no DELETE for an asset, so anything created here is archived at the
 * end and the counts are taken relative to whatever the form started with
 * rather than hardcoded.
 */

const MONTH = '2026-06';
const BASE = 'http://127.0.0.1:3001/api';

async function openAssets(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Assets' }).click();
  await expect(page.getByTestId('assets')).toBeVisible();
}

/**
 * 004-F, through the UI. Backing out of the archive prompt must leave the asset
 * alone: archiving a still-carrying loan strands its balance in net worth for
 * every future month, and the form never shows an archived asset again, so a
 * fall-through on "cancel" is unrecoverable without hand-editing the DB.
 */
test('004-F: cancelling the archive prompt leaves the asset untouched; closing at 0 archives it', async ({
  page,
  request,
}) => {
  const before = (await (await request.get(`${BASE}/asset-snapshots?month=${MONTH}`)).json()) as {
    assetId: number;
    name: string;
    valueCents: number | null;
  }[];
  const loan = before.find((e) => e.name === 'Car loan')!;
  expect(loan.valueCents, 'the loan must be carrying for this test to mean anything').toBeGreaterThan(0);

  const netWorthAt = async (month: string): Promise<number> => {
    const points = (await (
      await request.get(`${BASE}/dashboard/net-worth?window=12`)
    ).json()) as { month: string; netWorthCents: number }[];
    return points.find((p) => p.month === month)!.netWorthCents;
  };
  const netWorthBefore = await netWorthAt(MONTH);

  await openAssets(page);
  const rows = page.getByTestId('asset-entry').locator('li');
  const startCount = await rows.count();

  // --- Cancel must not archive ---------------------------------------------
  await page.getByTestId(`archive-${loan.assetId}`).click();
  await expect(page.getByTestId('archive-confirm')).toBeVisible();
  await page.getByTestId('archive-cancel').click();
  await expect(page.getByTestId('archive-confirm')).toBeHidden();
  await expect(rows).toHaveCount(startCount);

  // The API agrees: still listed, still carrying its original value.
  const afterCancel = (await (
    await request.get(`${BASE}/asset-snapshots?month=${MONTH}`)
  ).json()) as typeof before;
  expect(afterCancel.find((e) => e.assetId === loan.assetId)?.valueCents).toBe(loan.valueCents);
  expect(await netWorthAt(MONTH), 'cancelling must not move net worth').toBe(netWorthBefore);

  // --- Close at 0, then archive --------------------------------------------
  await page.getByTestId(`archive-${loan.assetId}`).click();
  await page.getByTestId('archive-zero-first').click();
  await expect(rows).toHaveCount(startCount - 1);

  // The closing 0 landed BEFORE the archive, so the loan stops subtracting and
  // net worth rises by exactly its balance — the 004-F "no phantom loan" result.
  expect(await netWorthAt(MONTH)).toBe(netWorthBefore + loan.valueCents!);

  // It is now listed as archived, with the warning about what archiving does not do.
  await expect(page.getByTestId(`archived-asset-${loan.assetId}`)).toBeVisible();
  await expect(page.getByTestId('archived-assets')).toContainText('keep counting in net worth');

  // --- Restore, through the UI this time ------------------------------------
  await page.getByTestId(`restore-${loan.assetId}`).click();
  await expect(rows).toHaveCount(startCount);

  // --- Restore the seed ------------------------------------------------------
  await request.put(`${BASE}/asset-snapshots`, {
    data: { month: MONTH, values: [{ assetId: loan.assetId, valueCents: loan.valueCents }] },
  });
  expect(await netWorthAt(MONTH)).toBe(netWorthBefore);
});

test('an asset can be added from the UI and starts counting once it has a value', async ({
  page,
  request,
}) => {
  const netWorthAt = async (month: string): Promise<number> => {
    const points = (await (
      await request.get(`${BASE}/dashboard/net-worth?window=12`)
    ).json()) as { month: string; netWorthCents: number }[];
    return points.find((p) => p.month === month)!.netWorthCents;
  };
  const netWorthBefore = await netWorthAt(MONTH);

  await openAssets(page);
  const rows = page.getByTestId('asset-entry').locator('li');
  const startCount = await rows.count();

  const name = `E2E holding ${Date.now()}`;
  await page.getByLabel('Asset name').fill(name);
  await page.getByLabel('Asset kind').selectOption('investment');
  await page.getByRole('button', { name: 'Add asset' }).click();

  await expect(rows).toHaveCount(startCount + 1);
  // Adding an asset alone must not move net worth — it has no snapshot yet.
  expect(await netWorthAt(MONTH)).toBe(netWorthBefore);

  await page.getByLabel(`${name} value`).fill('1 000,00 €');
  await page.getByRole('button', { name: `Save ${MONTH}` }).click();
  await expect(page.getByRole('status')).toContainText('Saved');

  expect(await netWorthAt(MONTH)).toBe(netWorthBefore + 100_000);

  await page.screenshot({ path: 'test-results/assets.png', fullPage: true });

  // --- Restore the seed: close at 0, then archive ---------------------------
  const created = (await (await request.get(`${BASE}/assets`)).json()) as {
    id: number;
    name: string;
  }[];
  const asset = created.find((a) => a.name === name)!;
  await page.getByTestId(`archive-${asset.id}`).click();
  await page.getByTestId('archive-zero-first').click();
  await expect(rows).toHaveCount(startCount);
  expect(await netWorthAt(MONTH)).toBe(netWorthBefore);
});
