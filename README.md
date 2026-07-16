# HelloFinance

Local-first personal finance tracker (single user, EUR only, S-Pankki CSV imports).
See [CLAUDE.md](./CLAUDE.md) for the binding constraints and workflow, and
[`specs/`](./specs) for feature specifications (the source of truth for behavior).

## Requirements

- Node >= 20 (developed on Node 24)

## Layout

```
packages/
  shared/   # @finance/shared — Zod schemas + shared types (API <-> UI)
  server/   # @finance/server — Fastify (127.0.0.1 only), SQLite + Drizzle
  web/      # @finance/web    — Vite + React
fixtures/   # synthetic S-Pankki data + expected.json (never real data)
specs/      # numbered feature specs
```

## Commands (run from repo root)

| Command                                  | What it does                                                     |
| ---------------------------------------- | ---------------------------------------------------------------- |
| `npm install`                            | Install all workspaces                                           |
| `npm run dev`                            | Start server (`:3001`) and web (`:5173`) together, loopback only |
| `npm run check`                          | `typecheck` + `lint` + unit/integration tests (Vitest)           |
| `npm run typecheck`                      | `tsc --noEmit` in every workspace                                |
| `npm run lint`                           | ESLint across the repo                                           |
| `npm test`                               | Vitest suites in `shared` and `server`                           |
| `npm run e2e`                            | Playwright end-to-end tests in `web`                             |
| `npm run fixtures:generate`              | Regenerate synthetic fixtures + `expected.json`                  |
| `npm run db:generate -w @finance/server` | Generate Drizzle migrations (none yet — no domain tables)        |

## Privacy posture (non-negotiable)

- Both the API and the Vite dev server bind to `127.0.0.1` only.
- No auth layer (localhost auth is theater).
- All money is integer cents; formatting to `1 234,56 €` happens only at the UI edge.
- Real financial data never enters the repo. Synthetic fixtures live in `fixtures/`;
  the real `data/*.db` and any real sample under `fixtures/private/` are gitignored.
