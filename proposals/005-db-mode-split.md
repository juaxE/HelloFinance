# Proposal 005 — DB mode split: real vs. dev databases

**Status:** approved by owner (2026-07-20). Implement as specified; behavioral
silences are stop-and-ask.

**Sequencing:** first of the four pre-import-hardening proposals (005–008).
Implement this one before the others — it touches the Playwright/seed plumbing
the other proposals' e2e additions will sit on. Branch from up-to-date `main`
(`git fetch origin && git switch main && git merge --ff-only origin/main`),
branch name suggestion: `feat/005-db-mode-split`.

Read `CLAUDE.md` fully before starting. Exit state: green `npm run check`,
green `npm run e2e`, committed.

## Why

Today the real database, the seeded dev database, and the e2e database are all
the same file: `data/app.db` (CWD-relative, so `packages/server/data/app.db`).
`seed:test` and the e2e suite overwrite it; `npm run dev` serves whatever sits
there. The `_synthetic_seed` marker guard (commit 651c1c1, `seed-guard.ts`)
protects only one direction: it stops `seed:test` from deleting a DB it didn't
create. The live hole: the DB on disk right now IS the marked synthetic seed;
if the owner's first real import goes into it via `npm run dev`, the marker
survives and a later `seed:test` or `npm run e2e` deletes real financial data
without complaint. The sibling hole: real imports into the seeded DB mix real
rows with synthetic ones and nothing flags it.

CLAUDE.md's tripwire "dev and test runs must be structurally unable to open the
real DB under `data/`" is currently unsatisfiable because there is no mode
concept at all. This proposal introduces one.

## Decided behavior

Two modes, selected by the `FINANCE_MODE` env var, values `real` | `dev`:

| mode   | DB path        | who runs it                                | marker semantics                        |
| ------ | -------------- | ------------------------------------------ | --------------------------------------- |
| `real` | `data/app.db`  | `npm start` (root) — the owner's daily app | must NOT have the `_synthetic_seed` marker |
| `dev`  | `data/dev.db`  | `npm run dev`, `seed:test`, Playwright     | must have the marker (written if fresh)  |

- **Missing or invalid `FINANCE_MODE` fails loudly** when the server (or
  seed script) resolves its database path — same philosophy as the existing
  `FINANCE_NOW` validation in `config.ts`. No default mode.
- **Startup guards, both directions** (this is the point of the proposal):
  - real mode + DB exists + marker present → refuse to start. Error message
    must tell the owner exactly what to do ("this is the synthetic seed; delete
    `data/app.db` (and -wal/-shm) or run `npm run dev`").
  - dev mode + DB exists + marker absent → refuse to start ("this database was
    not created by the seed and may hold real data; move it or delete it").
  - dev mode + fresh DB → after migrations, write the marker (reuse
    `markSyntheticSeed` from `seed-guard.ts`), so a dev-server-created DB is
    later overwritable by `seed:test`.
  - real mode + `FINANCE_NOW` set → refuse to start. CLAUDE.md already says
    FINANCE_NOW must never be set outside tests; make that structural.
- **The web UI shows a permanent, prominent banner in dev mode** ("Synthetic
  dev data — not your finances", or similar). This is the mitigation for the
  residual behavioral hole (a user importing a real CSV into a dev instance);
  it must be visible on every view, not just the dashboard.
- `seed:test` seeds the **dev** path unconditionally — it must not read
  `FINANCE_MODE` from the environment (it is definitionally synthetic). The
  existing `assertSeedableDatabase` guard stays as defense in depth.
- Drop the `DATABASE_URL` env override entirely (only `config.ts:17` and
  `drizzle.config.ts` reference it; tests use `createDb(':memory:')` directly).
  Modes own the paths; an override would bypass the guards. No backwards
  compatibility — this is unreleased single-user code.

## Current state (verified 2026-07-20, branch audit/pre-import-hardening)

- `packages/server/src/config.ts:17` — `DATABASE_PATH = process.env.DATABASE_URL ?? 'data/app.db'`,
  resolved at import time. **Trap:** every test transitively imports this module
  (via `db/client.ts`), so mode validation must NOT run at import time. Replace
  the constant with functions, e.g. `resolveMode(): 'real'|'dev'` (throws on
  missing/invalid) and `databasePathFor(mode)`; call them from `getDb()`
  (`db/client.ts:36`), `index.ts`, and `seed-test.ts` only.
- `packages/server/drizzle.config.ts` imports `DATABASE_PATH` at module load.
  Point it at the dev path explicitly with a comment: drizzle-kit is developer
  tooling; the real DB receives migrations at server startup
  (`index.ts` → `runMigrations`), never via drizzle-kit.
- `packages/server/src/index.ts` — entrypoint; add the guard calls here (or in
  a new module they delegate to). Guard logic must live in a testable module
  (suggest `src/db/mode-guard.ts`), not inline in the entrypoint.
- `packages/server/src/scripts/seed-guard.ts` — marker table
  `_synthetic_seed`, `assertSeedableDatabase`, `markSyntheticSeed`. Reuse; do
  not duplicate the marker name anywhere else.
- `packages/server/src/app.ts` — `buildApp(db, options)`. Add optional
  `mode: 'real' | 'dev'` to `AppOptions`, **defaulting to `'dev'`** (tests are
  definitionally synthetic; requiring it would ripple through every test file).
  Expose it in the `/health` response: `{ status: 'ok', mode }`.
- `packages/web/src/App.tsx` — app shell; fetch `/health` once, render the dev
  banner when `mode === 'dev'`.
- `packages/web/playwright.config.ts:42` — webServer env; add
  `FINANCE_MODE: 'dev'`.
- `packages/web/e2e/environment.setup.ts` — the anti-hijack gate; extend it to
  also assert the API reports `mode: 'dev'`.
- npm scripts:
  - `packages/server/package.json`: `dev` becomes `FINANCE_MODE=dev tsx watch src/index.ts`;
    `start` stays `tsx src/index.ts` (mode comes from the environment — this is
    what Playwright invokes with its own env).
  - root `package.json`: `dev` unchanged in shape (server dev script now pins
    dev mode); **new** `start` script runs server + web with `FINANCE_MODE=real`
    (env prefix on the root script propagates through npm to the workspace).
    Windows quoting is out of scope (CLAUDE.md: Windows support deferred).
- Root `.gitignore` already covers `data/` and `*.db` at any depth — `dev.db`
  needs no new rule.

## Acceptance criteria (name tests `criterion N: …`)

1. `FINANCE_MODE` unset or invalid → server startup and `seed:test` both fail
   with a message naming the variable and its two valid values. No DB file is
   created.
2. Real mode refuses to open a DB bearing `_synthetic_seed`, with remediation
   in the message; the file is untouched.
3. Dev mode refuses to open an existing DB lacking the marker; the file is
   untouched.
4. Dev mode on a fresh path creates, migrates, and marks the DB; a subsequent
   `seed:test` overwrites it without complaint (guard passes).
5. Real mode + `FINANCE_NOW` set → refuses to start.
6. `/health` reports the running mode; `buildApp` without an explicit mode
   reports `dev`.
7. The web UI renders the synthetic-data banner in dev mode on every view
   (Playwright: assert on at least two views; suite runs in dev so the banner
   is always expected).
8. `seed:test` writes `data/dev.db` regardless of `FINANCE_MODE` in the
   environment.

Guards are unit-tested against tempfile SQLite (never `data/*.db` — CLAUDE.md
validation §2). The full e2e suite must pass under the new plumbing; include a
Playwright screenshot showing the banner (validation §5, UI change).

## Documentation updates (same PR)

- README: commands table gains `npm start` (real mode) and `seed:test`; fix the
  stale "`db:generate` … (none yet — no domain tables)" note (five migrations
  exist); backup section keeps `data/app.db` as the real path; short section
  explaining the mode split and what to do the first time real mode refuses the
  leftover synthetic `app.db`.
- Optional one-line rider (owner: not pressing, but README currently claims
  it): add `fixtures/private/` to `.gitignore` so README's privacy claim is
  true, or delete the claim from README.
- CLAUDE.md tripwires: **rewrite** the final tripwire ("dev and test runs must
  be structurally unable…") to describe the actual mechanism (FINANCE_MODE,
  paths, bidirectional marker guards, no path override). **Extend** the
  FINANCE_NOW tripwire with "real mode refuses to start with it set". Add a
  line: "`seed:test` seeds the dev path unconditionally and never reads
  FINANCE_MODE."

## Explicitly out of scope

- Any change to what the seed contains.
- Auth, deployment, demo mode (see CLAUDE.md deferred list).
- Distinguishing real vs. synthetic CSV content at import time (impossible);
  the dev banner is the accepted mitigation.
- Automatic backups (may become its own proposal; README procedure stands).

## Migration note for the owner (put in the PR description)

After merge: `data/app.db` on disk is still the old synthetic seed. `npm run
dev` / e2e now use `data/dev.db` and will never touch it. The first `npm start`
will refuse it with instructions; deleting `packages/server/data/app.db*` by
hand is the expected one-time step before first real use.
