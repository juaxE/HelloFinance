import { expect, test } from '@playwright/test';

/**
 * The needs-review banner must survive the case where EVERY uncategorized row
 * sits in the month in progress — exactly what a mid-month import produces.
 *
 * The spending headline is a flow total and rightly excludes the partial month.
 * The banner is not a flow total, it is a signal, and gating it on that figure
 * made it disappear precisely when the backlog was newest.
 *
 * A 3-month window keeps this cheap: only two complete months have to be
 * cleared, not twelve. The spec restores every row it touches.
 */

const BASE = 'http://127.0.0.1:3001/api';
const PARTIAL = '2026-06';

type Queue = {
  totalCount: number;
  groups: { rows: { id: number; paymentDate: string }[] }[];
};

test('the needs-review banner survives all uncategorized spend being in the partial month', async ({
  page,
  request,
}) => {
  const queue = async (): Promise<Queue> =>
    (await (await request.get(`${BASE}/transactions/uncategorized`)).json()) as Queue;

  const cats = (await (await request.get(`${BASE}/categories`)).json()) as {
    id: number;
    name: string;
  }[];
  const other = cats.find((c) => c.name === 'Other')!.id;

  const before = await queue();
  const rows = before.groups.flatMap((g) => g.rows);

  // The two COMPLETE months inside a 3-month window ending at the partial one.
  const toClear = rows.filter(
    (r) => r.paymentDate.startsWith('2026-04') || r.paymentDate.startsWith('2026-05'),
  );
  const inPartial = rows.filter((r) => r.paymentDate.startsWith(PARTIAL));
  expect(toClear.length, 'fixture must have uncategorized rows in 2026-04/05').toBeGreaterThan(0);
  expect(inPartial.length, 'fixture must have uncategorized rows in the partial month').toBeGreaterThan(0);

  for (const row of toClear) {
    const res = await request.patch(`${BASE}/transactions/${row.id}`, {
      data: { categoryId: other, scope: 'one_off' },
    });
    expect(res.ok()).toBeTruthy();
  }

  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByTestId('spending-total').waitFor();
    await page.getByRole('button', { name: '3m' }).click();

    // The complete months now hold no uncategorized spend at all...
    await expect(page.getByTestId('spending-uncategorized')).toHaveCount(0);
    // ...but the signal is still there, and still routes to the queue.
    const banner = page.getByTestId('spending-needs-review');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('month in progress');
    await expect(banner).toContainText('needs review');

    await banner.getByRole('button', { name: 'Sort it out' }).click();
    await expect(page.getByTestId('triage')).toBeVisible();
  } finally {
    // --- Restore the seed ----------------------------------------------------
    for (const row of toClear) {
      await request.patch(`${BASE}/transactions/${row.id}`, {
        data: { categoryId: null, scope: 'one_off' },
      });
    }
  }

  const restored = await queue();
  expect(restored.totalCount, 'the seed must be left exactly as found').toBe(before.totalCount);
});
