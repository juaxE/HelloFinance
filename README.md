# HelloFinance

Local-first personal finance tracker (single user, EUR only, S-Pankki CSV imports).
See [CLAUDE.md](./CLAUDE.md) for the binding constraints, domain overview and
workflow. Behavior is specified by the test suite: tests are named after the
acceptance criterion they prove.

## Requirements

- Node >= 20 (developed on Node 24)

## Layout

```
packages/
  shared/   # @finance/shared — Zod schemas + shared types (API <-> UI)
  server/   # @finance/server — Fastify (127.0.0.1 only), SQLite + Drizzle
  web/      # @finance/web    — Vite + React
fixtures/   # synthetic S-Pankki data + expected.json (never real data)
```

## Commands (run from repo root)

| Command                                  | What it does                                                     |
| ---------------------------------------- | ---------------------------------------------------------------- |
| `npm install`                            | Install all workspaces                                           |
| `npm start`                              | **Real mode** — your finances (`data/app.db`), server + web      |
| `npm run dev`                            | **Dev mode** — synthetic seed (`data/dev.db`), server + web      |
| `npm run seed:test`                      | Load the synthetic fixtures into `data/dev.db`                   |
| `npm run check`                          | `typecheck` + `lint` + unit/integration tests (Vitest)           |
| `npm run typecheck`                      | `tsc --noEmit` in every workspace                                |
| `npm run lint`                           | ESLint across the repo                                           |
| `npm test`                               | Vitest suites in `shared` and `server`                           |
| `npm run e2e`                            | Playwright end-to-end tests in `web` (dev mode; stop `dev` first) |
| `npm run fixtures:generate`              | Regenerate synthetic fixtures + `expected.json`                  |
| `npm run db:generate -w @finance/server` | Generate Drizzle migrations into `packages/server/drizzle`       |

Both modes serve the API on `:3001` and the web app on `:5173`, loopback only,
so run only one at a time.

## Real vs. dev databases

The server picks its database from `FINANCE_MODE`, which has **no default** — an
unset or misspelled value refuses to start rather than guess:

| mode   | database      | started by                                     |
| ------ | ------------- | ---------------------------------------------- |
| `real` | `data/app.db` | `npm start`                                    |
| `dev`  | `data/dev.db` | `npm run dev`, `npm run seed:test`, Playwright |

Both paths are relative to the server workspace, so from the repo root they are
`packages/server/data/app.db` and `packages/server/data/dev.db`.

Every seeded database carries a `_synthetic_seed` marker table, and it is checked
in **both** directions: real mode refuses to open a marked database, and dev mode
refuses to open an unmarked one. That is what stops a real import from landing in
a database a later `seed:test` would cheerfully delete, and stops the seed from
overwriting real data. Dev mode also stamps the marker on any fresh database it
creates. In dev mode the UI shows a permanent banner saying the data is synthetic —
nothing can tell a real CSV from a synthetic one at import time, so that banner is
the only guard on that last step.

`FINANCE_NOW` (which pins "today" for tests) is refused outright in real mode: it
drives budget materialization and the past-month write lock, not just display.

**First run of `npm start`:** `packages/server/data/app.db` may still be the old
synthetic seed from before the split, in which case real mode will refuse it and
tell you so. Delete `packages/server/data/app.db` and its `-wal`/`-shm` siblings —
that one-time manual deletion is the deliberate act that says "this file is
disposable"; there is no `--force`.

## Backing up the real database

The real database is a single SQLite file at `packages/server/data/app.db`.
It runs in **WAL mode**, so a live copy of `app.db` alone can miss recent
writes sitting in `app.db-wal`. Either:

- **Stop the server first**, then copy `app.db` (a clean shutdown checkpoints
  the WAL), or
- copy all three files together (`app.db`, `app.db-wal`, `app.db-shm`), or
- with the server running, use SQLite's online backup:
  `sqlite3 packages/server/data/app.db ".backup 'backup-YYYY-MM-DD.db'"`.

Back up before every import session, and keep backups outside the repo.

## Privacy posture (non-negotiable)

- Both the API and the Vite dev server bind to `127.0.0.1` only.
- No auth layer (localhost auth is theater).
- All money is integer cents; formatting to `1 234,56 €` happens only at the UI edge.
- Real financial data never enters the repo. Synthetic fixtures live in `fixtures/`;
  the real `data/*.db` and any real sample under `fixtures/private/` are gitignored.
