# Proposal 007 — past-month write lock: closed months are fully read-only

**Status:** approved by owner (2026-07-20). Two decisions are already made and
are not open for re-litigation: **no retro-budgeting of backfilled months**,
and the lock covers **everything including notes** (month note and line
notes). Remaining behavioral silences are stop-and-ask.

**Sequencing:** third of the pre-import-hardening proposals (005–008).
Implement after 005 merges (this proposal reworks e2e specs that 005's
plumbing hosts). Branch from up-to-date `main`, suggestion:
`feat/007-past-month-lock`.

Read `CLAUDE.md` fully before starting. This proposal has the largest test
ripple of the four — budget the majority of the effort for the test rework,
not the route changes. Exit state: green `npm run check`, green `npm run e2e`,
committed.

## Why

CLAUDE.md says "`FINANCE_NOW` gates budget materialization and the past-month
write lock", and `POST /api/budgets/:month/lines/from-template/:templateId`
rejects past months with "past months are a historical record"
(`routes/budgets.ts:379-384`). But that is the ONLY route that checks. Plain
`POST /:month/lines`, `PATCH /:month/lines/:id`, `DELETE /:month/lines/:id`,
`PUT /:month/envelopes` (which happily materializes 2024-01 —
`routes/budgets.ts:126`), `PATCH /api/budgets/:month` (month note),
`POST /api/budgets`, and `GET /:month?open=1` all accept arbitrary past
months. The code currently supports two contradictory philosophies; the owner
has picked one: **a month closes when it ends. Past months are a historical
record, full stop.**

## Decided behavior

"Past" means `month < currentMonth()` — the injected clock
(`buildApp`'s `now` option / `FINANCE_NOW`), evaluated per request. The
current month and all future months remain writable (budgeting ahead is
legitimate; `?open=1` exists for exactly that).

For any past month, in `packages/server/src/routes/budgets.ts`:

- `POST /api/budgets` (materialize) → **409**.
- `GET /api/budgets/:month?open=1` on an unmaterialized past month → returns
  the existing `{ month, uncreated: true }` marker instead of materializing.
  NOT an error: glancing at un-budgeted history is legitimate; the truth about
  it is "never budgeted". (Materializing it now would snapshot lines from
  *current* template state — fabricated history.)
- `GET` on an already-materialized past month → unchanged: full reconciliation,
  read-only. Actuals still recompute live (that is the spec'd design — actuals
  are never stored; only the *plan* is locked).
- `PUT /:month/envelopes` → 409, checked **before** the `materializeMonth`
  call.
- `POST /:month/lines` → 409.
- `PATCH /:month/lines/:id` → 409, **all fields including `note`**.
- `DELETE /:month/lines/:id` → 409.
- `PATCH /api/budgets/:month` (month note) → 409.
- `POST /:month/lines/from-template/:templateId` → keep existing check; unify
  its message with the shared one.

Mechanics: one shared helper (e.g. `assertMonthWritable(month, currentMonth)`
returning the same `{status, body}` shape as `validateLine`) used by every
route above, with one consistent error message and hint. Additionally,
`materializeMonth` (`budgets/materialize.ts:28`) must **throw** if asked to
create a past month — belt-and-braces so no future route can bypass the lock
(mirror the reasoning of the keyless-line refusal in `reconcile.ts:140-148`).

Web (`packages/web/src/components/BudgetsPage.tsx`, `BudgetMonthView.tsx`,
`BudgetMakingScreen.tsx`): past months render read-only — no goal inputs, no
add-line affordance, no "open this month" action, no note editing; show a
short "closed month — historical record" indicator. The server 409s are the
protection; the UI just should not offer dead buttons.

## Test ripple (verified 2026-07-20 — do these, not just the routes)

Unit tests build past-month state through the routes and will break. Two
sanctioned rework patterns:

- **Align the clock:** where a file's months were arbitrary, move its `NOW` to
  make the working month current.
- **Two-app history simulation:** where a test genuinely needs history (a month
  materialized "back then", envelopes set "back then"), build a second app over
  the same db with `now` pinned to that month, write through it, then assert
  through the main app. `buildApp(db, { now })` is cheap; this is the honest
  simulation of "written while current".

Known affected files:

- `packages/server/test/budgets.lines.test.ts` — `NOW = 2026-03-15` (line 21)
  but works almost entirely on month **2025-07** (~30 references). Simplest
  global fix: `NOW = 2025-07-15`. The criterion-20 suggestion tests that seed
  the *previous* month's envelopes (2025-06) then need the two-app pattern.
- `packages/server/test/budgets.reconcile.test.ts` — `NOW = 2026-03-15`,
  works on 2025-07 (~29 refs). Same fix. (Tests calling `reconcileMonth`
  directly are unaffected — the lock is route-level plus materialize-level.)
- `packages/server/test/budgets.materialize.test.ts` — `NOW = 2026-03-15`;
  `materialize('2025-08')` at ~line 286 deliberately builds "a past month" for
  the `addableToMonths` exclusion (criterion tests around 25/15 also touch
  ended templates across time). These need the two-app pattern — they are
  exactly the "genuine history" case.
- e2e `packages/web/e2e/budgets.spec.ts` — pinned current month is **2026-06**
  (`FINANCE_NOW=2026-06-15` in `playwright.config.ts`), but the suggestion
  flow writes envelopes into `SUGGESTION_PREVIOUS = '2025-08'` and
  `UNTOUCHED_PREVIOUS = '2025-10'` via the UI, then opens 2025-09/2025-11 —
  every one of those is a past-month write or open. Rework:
  - Seed one historical envelope (e.g. Groceries, 2026-05) in
    **`seed-test.ts` only** — it represents "the owner budgeted May while it
    was current". Deliberately NOT in `test/helpers.ts:seedFixtureApp`: the
    unit-test baselines model "no budgets yet" and must stay unchanged. Add a
    comment at both sites explaining the asymmetry (the existing
    "keep-seed-paths-in-step" tripwire is about labeling rules; this is a
    deliberate, documented divergence — if that reads as too subtle, ask the
    owner rather than silently syncing both paths).
  - Suggestion test: open **2026-06** (current), assert the May seed surfaces
    as a suggestion.
  - Untouched-suggestion / no-envelope tests: use future months (2026-07+,
    writable). Mind `workers: 1` and the shared seeded DB — the dashboard spec
    PUTs a Groceries envelope on 2026-06 (`dashboard.spec.ts:34`), so pick
    months/categories that don't collide, and keep the file-order comment at
    `budgets.spec.ts:14` truthful.
- New e2e coverage for the lock itself: navigate to a past month, assert the
  read-only rendering and that no write affordance exists (screenshot per
  validation §5 — this is a UI change).

Audit beyond this list: grep the server tests and e2e specs for writes to any
month earlier than that file's pinned now before declaring done.

## Acceptance criteria (name tests `criterion N: …`)

1. Every write route listed above returns 409 for a past month and provably
   changes nothing (re-read the month; byte-equal reconciliation).
2. `GET ?open=1` on an unmaterialized past month returns the uncreated marker
   and creates no `budgets` row.
3. An already-materialized past month still returns full reconciliation, and
   its actuals still move when a transaction in that month is relabeled
   (actuals live, plan locked).
4. The current month and a future month accept the same writes the past month
   rejected (same payloads, 2xx).
5. `materializeMonth` called directly with a past month throws.
6. Month rollover: with `now` at the 1st of a month, the previous month is
   locked (boundary is strict `<`).
7. UI: past month renders read-only (e2e), current month renders editable.

## Documentation updates (same PR)

CLAUDE.md tripwires: replace the ambiguous "`FINANCE_NOW` gates … the
past-month write lock" phrasing with the now-true rule, e.g.: *"Past months
(`< currentMonth`) are fully read-only — no materialization, lines, envelopes,
or note edits; enforced by a shared guard in every budgets route AND by a
throw inside `materializeMonth` so no insert path can bypass it. Actuals in a
closed month still recompute live; only the plan is frozen. The only write
path into a month closes when the month does."* Note the from-template check
is no longer special — delete any wording implying it is.

## Explicitly out of scope

- Any admin/escape hatch for editing closed months. None. If history is wrong,
  the fix is data-level and deliberate, not an endpoint.
- Transaction notes/relabels in past months — those stay editable (they are
  the actuals side, spec'd to stay live).
- Budget rollover / income budgeting (deferred list).
