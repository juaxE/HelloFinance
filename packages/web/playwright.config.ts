import { defineConfig, devices } from '@playwright/test';

const BASE_URL = 'http://127.0.0.1:5173';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Reseeds data/app.db from fixtures (CLAUDE.md validation §3), then
      // serves the API. cwd is the repo root so the `-w` workspace flag
      // resolves.
      command: 'npm run seed:test -w @finance/server && npm run start -w @finance/server',
      cwd: '../..',
      // The synthetic fixtures run 2025-07..2026-06 while the real current month
      // moves. Pinning "today" inside that span keeps the dashboard's
      // current-month cards on a month the seed actually has data for; without
      // it they would all render empty and criteria 10/11 would assert nothing.
      env: { ...process.env, FINANCE_NOW: '2026-06-15' },
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
