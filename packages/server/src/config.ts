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
