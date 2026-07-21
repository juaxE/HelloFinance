import { expect, test as setup } from '@playwright/test';

/**
 * A precondition check that runs before every spec, as a project dependency.
 *
 * The suite asserts figures from the synthetic fixtures, which run
 * 2025-07..2026-06, so the server has to be pinned inside that span —
 * `playwright.config.ts` sets `FINANCE_NOW` on the server it starts.
 *
 * But `reuseExistingServer` is on locally, and it reuses whatever already
 * answers on :3001 WITHOUT applying that env. An ordinary `npm run dev` server
 * therefore silently takes over the whole suite, and every month-sensitive
 * assertion fails somewhere far from the cause. Worse, that server holds an open
 * handle to a `data/dev.db` that `npm run seed:test` has already unlinked, so
 * reseeding appears to do nothing.
 *
 * Fail here instead, once, with the fix in the message. Two independent things
 * are checked because a reused server defeats both: the pinned month, and the
 * database mode (a `npm start` server on :3001 would be serving real finances).
 */
const PINNED_MONTH = '2026-06';

setup('the server under test is pinned to the fixture span', async ({ request }) => {
  const res = await request.get('http://127.0.0.1:3001/api/dashboard/recurring-commitments');
  expect(res.ok(), 'no API answering on 127.0.0.1:3001').toBeTruthy();

  const { month } = (await res.json()) as { month: string };
  expect(
    month,
    `The API on :3001 reports ${month}, not ${PINNED_MONTH}. That is almost certainly a plain ` +
      `"npm run dev" server: Playwright reuses whatever is already listening and does not apply ` +
      `FINANCE_NOW to it, and it is pinning an app.db that seed:test has already replaced. ` +
      `Stop that server, run "npm run seed:test", and re-run the suite.`,
  ).toBe(PINNED_MONTH);
});

setup('the server under test is attached to the dev database', async ({ request }) => {
  const res = await request.get('http://127.0.0.1:3001/health');
  expect(res.ok(), 'no API answering on 127.0.0.1:3001').toBeTruthy();

  const { mode } = (await res.json()) as { mode: string };
  expect(
    mode,
    `The API on :3001 reports mode "${mode}", not "dev". The suite seeds and mutates its ` +
      `database, so it must run against data/dev.db. Stop whatever server is running ` +
      `(an "npm start" server serves your real finances) and re-run the suite.`,
  ).toBe('dev');
});
