/**
 * Server configuration. Privacy non-negotiables live here so they are easy to
 * audit: the host is hard-pinned to loopback and must never be overridable to
 * 0.0.0.0 (see CLAUDE.md non-negotiable #2).
 */

/** Loopback only. Not configurable on purpose. */
export const HOST = '127.0.0.1' as const;

export const PORT = Number(process.env.PORT ?? 3001);

/**
 * Path to the SQLite database file. Everything under `data/` is gitignored so
 * the real DB can never be committed (non-negotiable #1/#5). Tests never use
 * this path — they pass an in-memory or tempfile database explicitly.
 */
export const DATABASE_PATH = process.env.DATABASE_URL ?? 'data/app.db';

/**
 * Pins "today" for the running server, as `YYYY-MM-DD`. Unset in normal use, so
 * the app follows the wall clock.
 *
 * It exists because the synthetic fixtures cover a fixed span (2025-07..2026-06)
 * while "the current month" moves: without it, the dev app and the Playwright
 * run would open the dashboard on a month the seed has no data for, and every
 * current-month card would render empty. `buildApp` already accepts an injectable
 * `now` for the same reason on the test side (see app.ts).
 */
export const NOW_OVERRIDE = process.env.FINANCE_NOW ?? null;
