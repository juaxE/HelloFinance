# Proposal 006 — enforce the opening_balance_date forward-edit guard

**Status:** approved by owner (2026-07-20). Implement as specified; behavioral
silences are stop-and-ask.

**Sequencing:** second of the pre-import-hardening proposals (005–008); no code
dependency on 005 — only merge-order convenience. Branch from up-to-date
`main`, suggestion: `fix/006-opening-date-guard`.

Read `CLAUDE.md` fully before starting. Exit state: green `npm run check`,
green `npm run e2e`, committed.

## Why

CLAUDE.md carries this tripwire: *"Editing `opening_balance_date` forward past
committed transactions is rejected — it silently drops rows from the balance
window."* An external audit (2026-07-20) found it is **documented but not
implemented**: `PATCH /api/accounts/:id`
(`packages/server/src/routes/accounts.ts:39-83`) enforces only the
cents-without-date consistency refinement (`openingBalanceIsConsistent`,
`packages/shared/src/account.ts:19`). Nothing queries committed transactions;
no test covers it; the web UI has no guard either. Moving the date forward
today silently shrinks the balance window
(`balance(D) = opening + Σ amount WHERE opening_balance_date ≤ payment_date ≤ D`)
and corrupts every derived balance and net-worth point. Opening balances are
exactly what gets adjusted around a first real import, so this lands before it.

## Decided behavior

On `PATCH /api/accounts/:id`, after computing the merged state (the handler
already merges patch + existing for the 001-A check):

- If the merged `openingBalanceDate` is non-null AND the account has at least
  one committed transaction with `payment_date < mergedDate` → **409** with an
  error message that names the earliest committed `payment_date` and the count
  of transactions that would fall out of the window, plus a hint (keep the
  date at or before the earliest committed row; adjusting the anchor forward
  would require recomputing the opening balance, which only the import-time
  extend-history assist does — in the other direction).
- This formulation deliberately also covers setting a date on an account whose
  date was previously null while older rows exist: same corruption, same 409.
- Everything else stays allowed: null date (no lower bound), any date ≤ the
  earliest committed `payment_date` (equal is fine — the window is inclusive),
  any date on an account with no transactions, and backward moves (they widen
  the window; rows before the old date cannot exist because import rejects
  them).

Status code 409, not 400: this is a conflict with committed data, matching the
codebase convention (extend-history 409, budget line-key clashes 409;
validation-shape errors are 400).

Enforce in the route handler with a direct query (`min(payment_date)` for the
account). Do not push this into the Zod schema — it needs the DB. The web UI
(`AccountsPage` does not exist; accounts are edited via API only today) needs
no change; per the codebase's own principle, "UI hiding the button is not the
protection" anyway.

## Acceptance criteria (add to `packages/server/test/accounts.routes.test.ts`, named `criterion N: …`)

1. Account with committed transactions from 2025-07-01: PATCH
   `openingBalanceDate` to 2025-08-01 → 409; the account row is unchanged; the
   error names 2025-07-01 and the dropped-row count.
2. Same account: PATCH date to exactly the earliest committed `payment_date`
   → 200.
3. Account with `openingBalanceDate: null` and committed rows: PATCH a date
   later than the earliest row → 409; PATCH a date ≤ earliest row → 200.
4. Account with no transactions: any date, including far future → 200.
5. PATCH date to null (with cents 0) on an account with committed rows → 200
   (widening is safe).

Build test data through the import pipeline or direct inserts against
in-memory SQLite per existing patterns in that file. No e2e needed beyond the
suite staying green (no UI change), but state explicitly in the PR what was
not tested.

## Documentation updates (same PR)

CLAUDE.md: the tripwire line already exists and becomes true — no new line
needed. Optionally append "(enforced in `PATCH /api/accounts/:id`, 409)" so
the next auditor can find the enforcement.

## Explicitly out of scope

- A forward-move-with-recompute assist (the inverse of extend-history). If the
  owner ever needs it, it is its own proposal; the 409 hint mentions manual
  recomputation as the workaround.
- Changes to `extendHistory` (`import/pipeline.ts:591`) — it moves the date
  backward with recompute and is unaffected by this guard.
