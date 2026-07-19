# Proposal 008 — pending-import resume + commit-time dedup re-verification

**Status:** approved by owner (2026-07-20). Behavioral silences are
stop-and-ask.

**Sequencing:** last of the pre-import-hardening proposals (005–008).
Implement after 005 (e2e plumbing) merges; independent of 006/007 in code.
Branch from up-to-date `main`, suggestion: `feat/008-import-resume`.

Read `CLAUDE.md` fully before starting. Exit state: green `npm run check`,
green `npm run e2e`, committed.

## Why (two related gaps, one surface)

1. **An interrupted review is unreachable.** There is no `GET /api/imports`
   list endpoint; `ImportPage.tsx` holds the pending import only in React
   state (`packages/web/src/components/ImportPage.tsx:12`). Close the tab
   mid-review and the pending import — including every chosen category and
   remember-rule flag, all safely persisted in `staged_transactions` — is
   orphaned. For the owner's imminent first real import (~a year of history,
   one long review session) that is hours of labeling at risk. Orphaned
   staged rows also accumulate invisibly (only commit/discard deletes them).
2. **Commit trusts analyze-time dedup.** `commitImport`
   (`import/pipeline.ts:431`) inserts every staged `dup_state='new'` row as-is.
   If the same file is analyzed twice (two tabs, a re-upload) and both are
   committed, the second commit hits `uq_transactions_archive_id`, the
   transaction rolls back (integrity holds — good), and the API surfaces an
   unhandled 500 with no path forward; the import stays `pending_review`.
   Resume (gap 1) makes stale pending imports *more* reachable, so this must
   land together with it.

## Decided behavior

### A. Import listing + resume

- **`GET /api/imports`** — all imports, newest first, optional
  `?status=pending_review|committed|discarded` filter. Response rows:
  `{ id, filename, accountId, bank, status, encoding, rowCount,
  insertedCount, duplicateCount, createdAt }`. Zod schema + shared type in
  `packages/shared/src/import.ts`, following the existing serializer
  conventions (`routes/serialize.ts`).
- **ImportPage resume affordance:** on mount, fetch pending imports. If any
  exist, render a "Pending review" list above the upload form — filename,
  account name, created date, new/duplicate counts — each with a **Resume**
  button that fetches `GET /api/imports/:id` (already exists) and opens the
  existing `ReviewScreen` with it. No Discard button on the list itself:
  discard already lives inside `ReviewScreen`, keeping destructive actions on
  the screen that shows what is being destroyed.
- The list shows pending imports only. A full import-history view is out of
  scope (the endpoint supports it; the UI does not grow it now).

### B. Commit-time dedup re-verification

`commitImport` re-verifies, inside its transaction, immediately before
inserting: for the eligible (`new`, not before-opening) rows, re-query
committed `transactions` by `archive_id` (and by `content_hash` among
`archive_id IS NULL` rows, mirroring the analyze-time fallback exactly —
extract a small shared helper so analyze and commit cannot drift). Rows that
have become duplicates since analyze are **skipped and counted**, not
errored — this is non-negotiable #4's spirit: re-importing overlap must never
create duplicates, and committing stale staging IS a re-import.

Consequences to implement precisely:

- `inserted` = rows actually inserted; `duplicates` = analyze-time
  `duplicateCount` + newly-discovered; persist the updated `duplicateCount`
  and `insertedCount` on the `imports` row.
- The `allowUncategorized` check must count unlabeled rows **after** the
  re-verification — a stale-duplicate uncategorized row must not force the
  flag for rows that will never insert.
- Rule learning (`rememberGroups`) is unchanged: a user-confirmed
  remember-rule is a decision about the counterparty, valid even if every row
  of its group became a duplicate.
- An all-stale commit succeeds with `inserted: 0`, status `committed`.
- Do NOT add a uniqueness constraint on `content_hash` (existing tripwire:
  two identical same-day purchases are legal).

## Current state pointers (verified 2026-07-20)

- Routes: `packages/server/src/routes/imports.ts` (no list endpoint; error
  mapping helper at top to reuse).
- Pipeline: `packages/server/src/import/pipeline.ts` — analyze-time dedup at
  lines 65-102 (the logic to extract/share), commit at 431-532.
- Web API client: `packages/web/src/api.ts` (request helper + import calls at
  lines 67-99).
- Seed: `seed-test.ts` leaves the overlap import (`overlap-2026-06_2026-07.csv`)
  in `pending_review` on Main — 28 duplicates, 14 new groups. The e2e resume
  test should use it: reload the app, see it listed, resume, assert the
  ReviewScreen renders its groups. **It must neither commit nor discard it** —
  `workers: 1` and every later spec share the seeded DB, and committing would
  shift dashboard figures asserted elsewhere (see `playwright.config.ts:8-13`).
  Do not hardcode its import id; find it via the new list endpoint.

## Acceptance criteria (name tests `criterion N: …`)

1. `GET /api/imports` lists imports newest-first with correct counts;
   `?status=pending_review` filters; unknown status value → 400.
2. Analyze the same fixture twice into two pending imports; commit both. The
   second commit returns 2xx with `inserted: 0`, `duplicates` equal to its
   full row count, DB transaction count unchanged, import status `committed`.
   No 500, no partial insert.
3. Mixed staleness: file B overlaps file A partially; analyze both, commit A
   then B → B inserts exactly the non-overlapping rows; totals reconcile with
   `fixtures/expected.json` where applicable (validation §5 — this touches
   import: include computed totals in the PR).
4. Post-re-verification `allowUncategorized`: an import whose only unlabeled
   rows went stale commits without the flag.
5. Re-commit of an already-committed import stays the idempotent no-op it is
   today (`computeCommittedCounts` path untouched).
6. UI: with a pending import in the DB, reloading the app shows the pending
   list; Resume opens the review screen with the staged decisions intact
   (chosen categories survive the reload — that is the whole point).
   Playwright spec + screenshot (validation §5, UI change). New spec file must
   be mutation-free toward shared state (see seed note above).
7. With no pending imports, the ImportPage renders exactly as today.

## Documentation updates (same PR)

CLAUDE.md tripwire additions: *"`commitImport` re-verifies dedup inside its
transaction and skips-and-counts rows that became duplicates since analyze —
committing stale staging is a re-import, never an error; do not 'simplify' it
back to trusting `dup_state`."* And: *"The e2e resume spec reads the seeded
pending overlap import and must never commit or discard it — later specs
assert figures that assume it stays pending."*

## Explicitly out of scope

- Import history UI beyond the pending list.
- Deleting/pruning orphaned `staged_transactions` of discarded imports (the
  discard path already deletes; nothing else accumulates once resume exists).
- Multi-file upload, additional bank adapters (deferred list).
