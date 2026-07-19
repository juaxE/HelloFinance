import { expect, test } from '@playwright/test';

/**
 * The one triage path the seed cannot produce on its own: a group whose
 * counterparty ALREADY has a labeling rule while its rows are still
 * uncategorized.
 *
 * That state is reached the way a real user reaches it — relabel one
 * transaction with "update rule". The rule is created, and the sweep that
 * follows only touches rows whose source is already `rule`, so the siblings stay
 * uncategorized. That gap is the whole reason triage exists.
 *
 * Triage never UPDATEs a rule, so picking a different category has to close the
 * bulk path and leave the per-row path open. This spec mutates the shared seed
 * and restores it completely, asserting the restoration at the end.
 */

const BASE = 'http://127.0.0.1:3001/api';
const KEY = 'CDON';

type Queue = {
  totalCount: number;
  groups: { normalizedCounterparty: string; count: number; rows: { id: number }[] }[];
};

test('a rule pointing elsewhere closes the bulk path and leaves the per-row path open', async ({
  page,
  request,
}) => {
  const api = {
    queue: async (): Promise<Queue> => (await (await request.get(`${BASE}/transactions/uncategorized`)).json()) as Queue,
    categoryId: async (name: string): Promise<number> => {
      const all = (await (await request.get(`${BASE}/categories`)).json()) as { id: number; name: string }[];
      return all.find((c) => c.name === name)!.id;
    },
  };

  const before = await api.queue();
  const group = before.groups.find((g) => g.normalizedCounterparty === KEY)!;
  expect(group.count, 'the fixture must supply a multi-row CDON group').toBeGreaterThan(1);

  const shopping = await api.categoryId('Shopping');
  const seedRow = group.rows[0]!.id;

  // --- Reach the state: one row relabelled with "update rule" ---------------
  const patched = await request.patch(`${BASE}/transactions/${seedRow}`, {
    data: { categoryId: shopping, scope: 'update_rule' },
  });
  expect(patched.ok()).toBeTruthy();

  const rules = (await (await request.get(`${BASE}/labeling-rules`)).json()) as {
    id: number;
    normalizedCounterparty: string;
  }[];
  const rule = rules.find((r) => r.normalizedCounterparty === KEY)!;
  expect(rule, 'update_rule should have created the rule').toBeDefined();

  // The siblings did NOT follow the new rule — they were uncategorized, and the
  // relabel sweep cannot see rows whose source is null.
  const afterPatch = await api.queue();
  const stillQueued = afterPatch.groups.find((g) => g.normalizedCounterparty === KEY)!;
  expect(stillQueued.count).toBe(group.count - 1);

  // --- The group now advertises its rule ------------------------------------
  await page.goto('/');
  await page.getByTestId('nav-triage').click();
  const card = page.getByTestId(`triage-group-${KEY}`);
  await expect(card.getByTestId('triage-existing-rule')).toContainText('rule → Shopping');

  // Agreeing with the rule keeps the one-click path, and offers no "remember"
  // button — there is nothing to remember, the rule is already there.
  await card.getByLabel(`Category for ${KEY}`).selectOption({ label: 'Shopping' });
  await expect(page.getByTestId(`triage-apply-${KEY}`)).toBeEnabled();
  await expect(page.getByTestId(`triage-remember-${KEY}`)).toHaveCount(0);
  await expect(page.getByTestId(`triage-conflict-${KEY}`)).toHaveCount(0);

  // --- Disagreeing closes the bulk path -------------------------------------
  await card.getByLabel(`Category for ${KEY}`).selectOption({ label: 'Other' });
  await expect(page.getByTestId(`triage-apply-${KEY}`)).toBeDisabled();
  const conflict = page.getByTestId(`triage-conflict-${KEY}`);
  await expect(conflict).toContainText('A rule already sends CDON to Shopping');
  await expect(conflict).toContainText('one at a time');

  await page.screenshot({ path: 'test-results/triage-rule-conflict.png', fullPage: true });

  // The server refuses it too, so no UI path can bypass the restriction.
  const other = await api.categoryId('Other');
  const rejected = await request.post(`${BASE}/transactions/triage/group`, {
    data: { normalizedCounterparty: KEY, categoryId: other, rememberRule: false },
  });
  expect(rejected.status()).toBe(409);

  // The pointer to where a rule CAN be changed actually goes there.
  await conflict.getByRole('button', { name: 'Rules screen' }).click();
  await expect(page.getByRole('heading', { name: 'Rules' })).toBeVisible();

  // --- The per-row path stays open ------------------------------------------
  await page.getByTestId('nav-triage').click();
  await card.getByRole('button', { name: 'Expand' }).click();
  const rowId = stillQueued.rows[0]!.id;
  await card.getByLabel(`Category for transaction ${rowId}`).selectOption({ label: 'Other' });

  // Down to a single row, the group is no longer a repeat counterparty: it is
  // demoted to the one-at-a-time section, where no rule is offered at all.
  expect(group.count - 2, 'this assertion assumes CDON drains to exactly one row').toBe(1);
  await expect(page.getByTestId(`triage-group-${KEY}`)).toHaveCount(0);
  await expect(page.getByTestId(`triage-singleton-${KEY}`)).toBeVisible();

  // --- Restore the seed ------------------------------------------------------
  for (const id of [seedRow, rowId]) {
    const res = await request.patch(`${BASE}/transactions/${id}`, {
      data: { categoryId: null, scope: 'one_off' },
    });
    expect(res.ok(), `failed to re-queue ${id}`).toBeTruthy();
  }
  expect((await request.delete(`${BASE}/labeling-rules/${rule.id}`)).ok()).toBeTruthy();

  const restored = await api.queue();
  expect(restored.totalCount, 'the seed must be left exactly as found').toBe(before.totalCount);
  expect(
    restored.groups.find((g) => g.normalizedCounterparty === KEY)!.count,
  ).toBe(group.count);
});
