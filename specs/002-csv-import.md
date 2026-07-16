# Spec 002 — CSV import & labeling

Status: **draft, awaiting owner approval**
Depends on: 001 (schema). Depended on by: 003, 004 (they read committed transactions).

## Purpose

Turn an S-Pankki CSV export into committed, categorized transactions through a
first-class in-app flow (not a script): upload → parse & dedup → review with
proposed labels → user confirms/corrects with **bulk "apply to all similar"** →
commit + persist learned rules. Imports are idempotent: re-importing an
overlapping file never creates duplicates (non-negotiable #4). The adapter sits
behind a bank-adapter interface so future banks slot in without touching the
pipeline — but S-Pankki is the only implementation now.

## Bank-adapter interface

```ts
// packages/server/src/import/adapter.ts
export interface ParsedTransaction {
  paymentDate: string; // YYYY-MM-DD (from Maksupäivä)
  bookingDate: string; // YYYY-MM-DD (from Kirjauspäivä)
  amountCents: number; // signed
  type: string; // Tapahtumalaji
  payer: string | null; // Maksaja
  payee: string | null; // Saajan nimi
  counterparty: string; // payee if amountCents<0 else payer (raw, pre-normalization)
  counterpartyIban: string | null; // spaces stripped
  counterpartyBic: string | null; // spaces stripped
  reference: string | null; // Viitenumero
  message: string | null; // Viesti, unwrapped
  archiveId: string | null; // Arkistointitunnus (null only for future banks)
}

export interface BankAdapter {
  id: 's-pankki';
  /** Sniff bytes -> transactions. Throws on a structurally invalid file. */
  detectEncoding(bytes: Uint8Array): 'utf-8' | 'iso-8859-1';
  parse(bytes: Uint8Array): { encoding: string; rows: ParsedTransaction[] };
}
```

The pipeline (dedup, staging, labeling, commit) is adapter-agnostic and consumes
`ParsedTransaction[]`.

## S-Pankki adapter — parsing rules

All verified against `fixtures/` (CLAUDE.md "S-Pankki CSV adapter"):

- **Encoding detection**: decode the bytes with `new TextDecoder('utf-8', { fatal: true })`;
  if it throws, decode as ISO-8859-1 (`latin1`). Then assert the header contains
  the expected Finnish tokens (`Kirjauspäivä`, `Arkistointitunnus`); a mismatch is
  a hard parse error (wrong file/bank). A UTF-8 BOM, if present, is stripped.
- **Delimiter**: `;`. Header row is Finnish; map by header name (not position) so a
  future column reorder does not silently corrupt data.
- **Dates**: `DD.MM.YYYY` → `YYYY-MM-DD`.
- **Amounts**: decimal comma, explicit sign (`-83,22`, `+2826,41`). Strip spaces,
  replace comma with dot, parse to **integer cents** (`Math.round` on the ×100
  value guarded against float drift — parse the integer and fractional parts
  separately rather than `parseFloat`). Result keeps its sign.
- **Empty sentinel**: a bare `'-'` (apostrophe-dash) means empty → `null`.
- **Message (Viesti)**: wrapped as a leading apostrophe + quotes
  (`'Palkka kaudelta 4/2026'`). Unwrap to the inner text; `'-'` → `null`.
- **IBAN / BIC**: may contain stray internal/trailing spaces
  (`FI98 3939 1111 1111 86 `, `SBAN FI HH`). Normalize by removing all whitespace.
- **counterparty (for labeling)**: `payee` (Saajan nimi) when `amountCents < 0`
  (outgoing), `payer` (Maksaja) when `amountCents > 0` (incoming). Zero-amount rows
  are not expected; if one appears, treat as outgoing and flag in the import log.
- **Type hints** (auto-label at parse): `type === 'OMA TILISIIRTO'` → **Transfer**;
  `type === 'PALKKA'` → **Income**. Recorded as `category_source='type_hint'`
  (decision 002-A).

## Normalization (counterparty → rule key)

Used both to propose labels and to group the review screen. Deterministic, pure:

1. Uppercase; trim; collapse internal whitespace to single spaces.
2. Strip known noise **prefixes** (repeat until stable): `PAYPAL *`, `VFI*`,
   `MOB.PAY*` (tolerate optional spaces around `*`). The list is a maintained
   constant.
3. Strip a trailing PayPal/processor token: a `*`-delimited trailing segment that
   is an opaque code (e.g. `*P41B7F3E9`) → drop it. `PAYPAL *SPOTIFY*P41B7F3E9`
   → `SPOTIFY`.
4. Strip standalone digit groups and card-tail artifacts (e.g. store numbers like
   `65975`).
5. **Brand canonicalization (merge same brand — decision 002-B):** if the result
   starts with a known brand key, collapse to that key so different locations of
   the same brand share one rule. `ALEPA PORVOONKATU` and `ALEPA KAMPPI` both →
   `ALEPA`; `K-MARKET KAMPPI` → `K-MARKET`; `SUBWAY REDI` → `SUBWAY`. The brand
   list is a maintained constant seeded with common Finnish grocery/retail chains
   (`LIDL`, `K-MARKET`, `K-CITYMARKET`, `S-MARKET`, `ALEPA`, `PRISMA`, `SALE`,
   `SUBWAY`, `HESBURGER`, `ROBERTS COFFEE`, `R-KIOSKI`, …) and is intended to
   become **user-editable** (add a brand → past groups re-collapse on the next
   import/review). Merchants not on the list keep their full normalized string.
6. Result is the `normalized_counterparty`.

The brand list is the one deliberately-lossy step; only known brands merge, so an
unknown merchant is never wrongly collapsed. Normalization is otherwise a
heuristic; imperfect grouping only means an extra review group, never wrong data,
because every label is user-confirmed. The reference implementation and asserted
examples live in `fixtures/generate.mjs` / `fixtures/expected.json`.

## Staging table (pre-commit review buffer)

```ts
// added by this spec's migration
export const stagedTransactions = sqliteTable('staged_transactions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  importId: integer('import_id')
    .notNull()
    .references(() => imports.id),
  // all ParsedTransaction fields, denormalized:
  paymentDate: text('payment_date').notNull(),
  bookingDate: text('booking_date').notNull(),
  amountCents: integer('amount_cents').notNull(),
  type: text('type').notNull(),
  payer: text('payer'),
  payee: text('payee'),
  counterparty: text('counterparty').notNull(),
  normalizedCounterparty: text('normalized_counterparty').notNull(),
  counterpartyIban: text('counterparty_iban'),
  counterpartyBic: text('counterparty_bic'),
  reference: text('reference'),
  message: text('message'),
  archiveId: text('archive_id'),
  contentHash: text('content_hash').notNull(),
  // dedup + review state
  dupState: text('dup_state', {
    enum: ['new', 'duplicate_existing', 'duplicate_in_batch'],
  }).notNull(),
  // When dup_state='duplicate_existing', the account the existing row belongs to —
  // lets the review UI explain a CSV imported into the wrong account (step 3).
  duplicateAccountId: integer('duplicate_account_id').references(() => accounts.id),
  // payment_date < the target account's opening_balance_date: outside the balance
  // window (decision 001-A), so NOT committed by default (step 6).
  beforeOpening: integer('before_opening', { mode: 'boolean' }).notNull().default(false),
  proposedCategoryId: integer('proposed_category_id').references(() => categories.id),
  proposedSource: text('proposed_source', { enum: ['manual', 'rule', 'type_hint'] }),
  // user decisions during review:
  chosenCategoryId: integer('chosen_category_id').references(() => categories.id),
  rememberRule: integer('remember_rule', { mode: 'boolean' }).notNull().default(false),
  note: text('note'), // optional per-transaction note entered during review; copied to transactions on commit
});
```

Staging holds parsed data only until commit or discard; a committed/discarded
import's staged rows are deleted. (Staging lives in the local SQLite DB — still
100% local, no privacy concern.)

## Import pipeline

1. **Upload** — `POST /api/imports` multipart: `file` + `accountId`. The raw bytes
   are held in memory only; the uploaded file is never written to disk.
2. **Detect + parse** — adapter yields rows + encoding. Create an `imports` row
   (`status='pending_review'`).
3. **Dedup + boundary check** — for each row compute `archive_id` and
   `content_hash`. Mark `dup_state`:
   - `duplicate_existing` if `archive_id` already in `transactions` — also record
     the **existing row's `account_id`** in `duplicate_account_id`, so a file
     imported into the wrong account surfaces as "already imported into <account>"
     rather than a baffling "0 inserted, all duplicates" (archive_id uniqueness is
     global, decision 001-B / spec 001);
   - `duplicate_in_batch` if the same `archive_id` appears earlier in this file;
   - else `new`.

   Then set `before_opening = true` for any row whose `payment_date` is earlier
   than the target account's `opening_balance_date` (skipped when that date is
   null). Such rows sit outside the balance window (decision 001-A) and are held
   back at commit.

4. **Propose labels** — for each `new` row: type hint first; else a `labeling_rules`
   match on `normalized_counterparty`; else none (proposed null). Record
   `proposed_source`.
5. **Review (interactive)** — the client fetches staged rows grouped by
   `normalized_counterparty`. The user confirms or overrides per group, with
   **"apply to all N similar"** setting `chosen_category_id` for the whole group,
   and a per-group **"remember as a rule"** toggle. One-by-one prompting is not
   acceptable (owner bulk-imports ~1 year).
6. **Commit** — `POST /api/imports/:id/commit`:
   - Insert only `new` rows into `transactions` (carrying any per-row `note`), with
     `category_id = chosen ?? proposed` and `category_source`: `'manual'` if the
     user set/overrode it,
     `'type_hint'` if it came from a Tapahtumalaji hint (Transfer/Income) with no
     user or rule override, else `'rule'` (decision 002-A). `'manual'` always wins.
   - **Rows dated before the opening balance are excluded (decision 001-A):** a
     `new` row with `before_opening = true` is **not** inserted — committing it
     would place a transaction outside the account's balance window, invisible to
     the balance. The review summary flags these and offers a one-click **"Extend
     history"** assist (decision 002-E): set `opening_balance_date` to the earliest
     excluded row's `payment_date` and recompute
     `opening_balance_cents := old_opening − Σ(excluded amount_cents)`, then
     re-analyze so the rows fall in-window. This is exact, not an estimate — the
     excluded rows are the _complete, contiguous_ history between the new and old
     dates (a bank export has no gaps), so `old_opening = new_opening + Σ(excluded)`
     by construction; the account balance at every date ≥ the old opening date is
     unchanged and only the older history becomes visible, with no statement lookup.
     (A manual date/amount edit stays available.) There is deliberately no "commit
     anyway" that would leave a row outside the window.
   - **Uncategorized allowed (decision 002-C):** a `new` row the user left
     unlabeled commits with `category_id = null` and `category_source = null`. It
     can be labeled later from the transactions list. The commit endpoint requires
     an explicit `allowUncategorized: true` flag when any `new` row is still null,
     so it's a deliberate choice, not an accident. Uncategorized is a distinct
     state from the reviewed **Other** category (see UI).
   - Upsert `labeling_rules(normalized_counterparty → category)` for every group
     with `remember_rule = true`. Manual override of an existing rule updates it.
   - Update `imports` counters + `status='committed'`; delete this import's staged
     rows.
   - Idempotent: re-running commit on an already-committed import is a no-op; and
     because `uq_transactions_archive_id` exists, a race or retry cannot double-insert.

**Manual beats rule** everywhere: a user choice sets `category_source='manual'` and
takes precedence over any rule, now and on future imports (a rule only auto-fills
rows the user has not manually decided).

## Relabeling / annotating a committed transaction

`PATCH /api/transactions/:id` with `{ categoryId?, scope?, note? }`:

- `categoryId` + `scope: 'one_off' | 'update_rule'`:
  - `one_off` — set the category, `category_source='manual'`; rules untouched.
  - `update_rule` — set the category **and** upsert the `labeling_rules` entry for
    this transaction's `normalized_counterparty`. Future imports and unlabeled
    matches follow the new rule; existing manually-labeled rows are not rewritten.
- `note` — set/clear the free-text transaction note. Independent of category; a
  note-only edit needs no `scope` and never touches rules.

The UI prompts which scope when the new category differs from what a rule would say.

## API surface

- `POST /api/imports` (multipart: `file`, `accountId`) → `{ importId, encoding,
counts: { total, new, duplicates }, groups: [...] }`.
- `GET /api/imports/:id` → staged rows + groups + current proposed/chosen labels.
- `PATCH /api/imports/:id/groups/:normalizedCounterparty` →
  `{ categoryId, rememberRule }` (bulk apply to the group).
- `PATCH /api/imports/:id/rows/:rowId` → `{ categoryId?, note? }` (single-row
  override and/or note).
- `POST /api/imports/:id/commit` `{ allowUncategorized?: boolean }` →
  `{ inserted, duplicates, uncategorized }`.
- `POST /api/imports/:id/discard` → drops staging, `status='discarded'`.
- `GET /api/labeling-rules`, `PATCH /api/labeling-rules/:id`,
  `DELETE /api/labeling-rules/:id` (management).
- `PATCH /api/transactions/:id` (relabel, see above).

## UI sketch

- **Import page**: drag-drop / file picker + account selector → "Analyze".
- **Review screen**: a summary banner ("42 new, 7 duplicates skipped, encoding:
  ISO-8859-1"). When duplicates already live in a **different** account than the
  import target, the banner names it ("7 duplicates — already imported into 'Main
  account'") so a wrong-account upload is obvious rather than a silent no-op. Rows
  dated **before the account's opening balance** are called out with a fix-it link
  to the account's opening-balance setting (they are not committed as-is). Below,
  one collapsible card per `normalized_counterparty` group
  showing the raw example, count, total amount, a category dropdown, an "apply to
  all N" affordance (the group control just is the bulk control), and a "remember
  as rule" checkbox. Groups already covered by an existing rule are pre-filled and
  visually marked "from rule". Duplicates are listed in a separate collapsed
  section, read-only. A sticky footer shows "N of M groups labeled" and a
  **Commit** button. Committing is allowed with some rows still unlabeled: an
  explicit "import the rest as Uncategorized (X rows)" confirmation. Those rows
  land in the **Uncategorized** state (visually distinct from the reviewed
  **Other** category — e.g. a dashed "needs review" chip vs a normal category
  pill), so the transactions list can surface "N transactions need review".
  Expanding a group lists its individual rows; a row can take an optional
  per-transaction **note** here, which is carried to the committed transaction.
- **Transactions list**: each transaction shows its note inline and can be
  edited/annotated (category and/or note) via `PATCH /api/transactions/:id`.
- **Rules management** (Settings): table of normalized counterparty → category,
  editable/deletable.

## Acceptance criteria

Assert against `fixtures/expected.json` (CLAUDE.md validation §5):

1. Importing the main synthetic file inserts exactly the expected count with
   correct signs, cents, and ISO dates for every transaction type present
   (KORTTIOSTO, TILISIIRTO, PALKKA, E-LASKU, OMA TILISIIRTO).
2. Re-importing the **same** file → `inserted = 0`, all `duplicate_existing`.
3. Importing the **overlapping** second file → inserts only its non-overlapping
   rows; overlapping `archive_id`s are skipped. Final transaction count equals the
   expected union.
4. The **ISO-8859-1** fixture decodes with correct `ä/ö` (e.g. `MEIKÄLÄINEN`), and
   its rows import correctly (asserted against `expected.json`).
5. `OMA TILISIIRTO` rows land in **Transfer**, `PALKKA` in **Income**, without user
   input.
6. Normalization: `PAYPAL *SPOTIFY*P41B7F3E9` → `SPOTIFY`, `VFI*BIO REX CINEMAS OY`
   → `BIO REX CINEMAS OY`, `MOB.PAY*RYDE FINLAND OY` → `RYDE FINLAND OY`, and
   brand-merge: `Alepa Porvoonkatu` and `Alepa Kamppi` both → `ALEPA`,
   `K-Market Kamppi 4021` → `K-MARKET` — all asserted against
   `fixtures/expected.json.normalizationExamples`.
7. Bulk "apply to all similar" sets one category across a whole group; with
   "remember rule", a subsequent import of a new row in that group is auto-labeled
   from the persisted rule.
8. Manual override beats a matching rule and persists as `category_source='manual'`.
9. A file whose rows already exist in a **different** account reports them as
   duplicates attributed to that account (banner names it) and inserts nothing —
   not a silent "0 inserted".
10. A row dated before the target account's `opening_balance_date` is flagged
    `before_opening` and excluded from commit; lowering the account's
    `opening_balance_date` to cover it turns it into a normal in-window committed
    row on re-analyze.
11. The **"Extend history"** assist (002-E) sets `opening_balance_date` to the
    earliest excluded row and `opening_balance_cents = old_opening −
Σ(excluded amount_cents)`; after re-analyze the previously-excluded rows commit
    in-window **and** the account balance at every date ≥ the old opening date is
    unchanged (cent-for-cent).
12. Playwright: screenshot of the review screen against seeded data with groups and
    duplicate count visible.

## Deferred (needs a new approved spec)

- Additional bank adapters (only the interface exists now).
- Automatic transfer **pair-matching** across accounts (OMA TILISIIRTO in/out).
- Split transactions during review.
- Fuzzy/token normalization beyond the deterministic rules above.

## Assumption: archive_id globally unique (owner-accepted 2026-07-16)

Global `archive_id` uniqueness (spec 001) assumes S-Pankki `Arkistointitunnus` is
unique **across all of the owner's accounts**, not just within one (it reads as a
date + sequence, so it very likely is). The owner **accepted this assumption for
now** (2026-07-16). It can't be verified in the dev cycle — all fixtures are
synthetic and no real export enters agent context (CLAUDE.md #5) — so it stays a
watch item: if a genuine cross-account collision ever appears in a real import,
revisit whether the constraint should become `(account_id, archive_id)`.

## Resolved decisions (owner, 2026-07-15)

- **002-A — Type-hint provenance.** ✅ Add `'type_hint'` to
  `transactions.category_source` (now `{'manual','rule','type_hint'}`, reflected in
  spec 001) so the relabel UX can tell deterministic Tapahtumalaji auto-labels
  (Transfer/Income) apart from learned counterparty rules. `'manual'` still wins.
- **002-B — Normalization: merge same brand.** ✅ Brand canonicalization added
  (step 5 above): known brands collapse across locations (`ALEPA PORVOONKATU` &
  `ALEPA KAMPPI` → `ALEPA`). Seeded brand list, intended to become user-editable.
- **002-C — Commit with leftovers.** ✅ Allowed, behind an explicit
  `allowUncategorized` confirmation. Leftover rows commit as **Uncategorized**
  (`category_id=null`), shown distinctly from the reviewed **Other** category so
  "needs review" is obvious in the UI.
- **002-D — Account inference.** ✅ Target account is chosen manually at upload (no
  IBAN inference).
- **002-E — "Extend history" opening-balance recompute (owner request,
  2026-07-16).** ✅ When an import contains rows dated before the account's
  `opening_balance_date`, the app offers a one-click recompute instead of leaving
  the arithmetic to the user: lower the opening date to the earliest excluded row
  and set `opening_balance_cents := old_opening − Σ(excluded amount_cents)`. Exact
  because the export's excluded rows are the complete history bridging the two
  dates, so recent balances are preserved and only older history appears. Closes
  the ergonomic gap where "lower the opening date" silently also required knowing
  the balance at a year-old date.

No open questions remain for this spec.
