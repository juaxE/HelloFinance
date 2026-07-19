/**
 * Server configuration. Privacy non-negotiables live here so they are easy to
 * audit: the host is hard-pinned to loopback and must never be overridable to
 * 0.0.0.0 (see CLAUDE.md non-negotiable #2).
 */

import { zFinanceMode, type FinanceMode } from '@finance/shared';

/** Loopback only. Not configurable on purpose. */
export const HOST = '127.0.0.1' as const;

export const PORT = Number(process.env.PORT ?? 3001);

/**
 * Paths to the SQLite database files, one per mode (proposal 005). Everything
 * under `data/` is gitignored so neither can be committed (non-negotiable
 * #1/#5). Tests never use these paths — they pass an in-memory or tempfile
 * database explicitly.
 *
 * There is deliberately no env override: the modes own the paths, and an
 * override would let a caller aim dev tooling at the real database and walk
 * straight past the marker guards in `db/mode-guard.ts`.
 */
export const REAL_DATABASE_PATH = 'data/app.db';
export const DEV_DATABASE_PATH = 'data/dev.db';

export function databasePathFor(mode: FinanceMode): string {
  return mode === 'real' ? REAL_DATABASE_PATH : DEV_DATABASE_PATH;
}

/**
 * Read the mode from `FINANCE_MODE`. There is no default: guessing is how real
 * data ends up under a dev workflow, so an unset or misspelled value refuses to
 * resolve a path at all.
 *
 * A function, not a module constant, on purpose — every test transitively
 * imports this module via `db/client.ts`, and validating at import time would
 * make the whole suite depend on an env var it has no business setting.
 */
export function resolveMode(): FinanceMode {
  const raw = process.env.FINANCE_MODE;
  const parsed = zFinanceMode.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `FINANCE_MODE must be "real" or "dev", got ${raw === undefined ? '(unset)' : `"${raw}"`}. ` +
        `"real" opens ${REAL_DATABASE_PATH} (your finances, "npm start"); ` +
        `"dev" opens ${DEV_DATABASE_PATH} (the synthetic seed, "npm run dev"). ` +
        'Refusing to guess.',
    );
  }
  return parsed.data;
}

/**
 * Pins "today" for the running server, as `YYYY-MM-DD`. Unset in normal use, so
 * the app follows the wall clock.
 *
 * It exists because the synthetic fixtures cover a fixed span (2025-07..2026-06)
 * while "the current month" moves: without it, the dev app and the Playwright
 * run would open the dashboard on a month the seed has no data for, and every
 * current-month card would render empty. `buildApp` already accepts an injectable
 * `now` for the same reason on the test side (see app.ts).
 *
 * This is NOT dashboard-only: `currentMonth()` also drives budget
 * materialization and the past-month write lock in `routes/budgets.ts`, where a
 * stale value would silently reopen months that are genuinely historical. So a
 * malformed value must fail at startup rather than degrade into `Invalid Date`
 * (which `monthOf` would happily render as `"NaN-NaN"`), and a valid one is
 * announced loudly — see `index.ts`.
 */
export const NOW_OVERRIDE = parseNowOverride(process.env.FINANCE_NOW);

function parseNowOverride(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(new Date(`${raw}T12:00:00`).getTime())) {
    throw new Error(
      `FINANCE_NOW must be a valid YYYY-MM-DD date, got "${raw}". It pins the server's "today" ` +
        'and controls budget materialization and the past-month write lock; refusing to start ' +
        'rather than run against a nonsense clock.',
    );
  }
  return raw;
}
