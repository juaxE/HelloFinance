import { defineConfig, devices } from '@playwright/test';

const BASE_URL = 'http://127.0.0.1:5173';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // Every spec runs against the ONE seeded `data/dev.db`, and several mutate it:
  // triage categorizes rows, the dashboard spec PUTs envelopes, the review spec
  // uploads. In parallel those interleave with the specs that assert the DOM
  // against a freshly-fetched API figure, which is a race, not a flake to retry
  // away. Four spec files run serially in well under a minute.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    // Gates every spec: a reused dev server silently defeats FINANCE_NOW and the
    // reseed. See environment.setup.ts.
    { name: 'setup', testMatch: /environment\.setup\.ts$/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
  ],
  webServer: [
    {
      // Reseeds data/dev.db from fixtures (CLAUDE.md validation §3), then
      // serves the API. cwd is the repo root so the `-w` workspace flag
      // resolves.
      command: 'npm run seed:test -w @finance/server && npm run start -w @finance/server',
      cwd: '../..',
      // The synthetic fixtures run 2025-07..2026-06 while the real current month
      // moves. Pinning "today" inside that span keeps the dashboard's
      // current-month cards on a month the seed actually has data for; without
      // it they would all render empty and criteria 10/11 would assert nothing.
      // FINANCE_MODE=dev pins the suite to `data/dev.db` — the seed's database,
      // which real mode is structurally unable to open (proposal 005).
      env: { ...process.env, FINANCE_NOW: '2026-06-15', FINANCE_MODE: 'dev' },
      url: 'http://127.0.0.1:3001/health',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'npm run dev',
      url: BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
