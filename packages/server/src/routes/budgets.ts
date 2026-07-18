import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import {
  zBudgetCreate,
  zBudgetLineCreate,
  zBudgetLinePatch,
  zBudgetPatch,
  zEnvelopesPut,
  zMonth,
} from '@finance/shared';
import type { Db } from '../db/client';
import { budgetLines, budgets, categories, recurringTemplates } from '../db/schema';
import {
  findEnvelopeForCategory,
  findLineByMatchKey,
  materializeMonth,
  snapshotLine,
} from '../budgets/materialize';
import { envelopeRelevantCategories, reconcileMonth } from '../budgets/reconcile';
import { clampDayToMonth, isTemplateDue, previousMonth } from '../budgets/months';
import { serializeBudgetLine } from './serialize';

/**
 * Budget months (spec 003). Materialization creates **recurring lines only** —
 * envelopes are never auto-created (decision 003-K), so a month with zero
 * envelope lines truthfully reports "not budgeted yet".
 */
export function registerBudgetRoutes(app: FastifyInstance, db: Db, currentMonth: () => string): void {
  /**
   * The month with its reconciliation.
   *
   * Auto-materializes the **current** month and any month the caller explicitly
   * opens (`?open=1`); any other absent month returns an uncreated marker rather
   * than being materialized on a glance (decision 003-C). Merely looking at a
   * month must not create it — a materialized month is a commitment (its lines
   * are a historical record, and deletions in it are durable).
   */
  app.get('/api/budgets/:month', async (req, reply) => {
    const month = (req.params as { month: string }).month;
    if (!zMonth.safeParse(month).success) {
      return reply.code(400).send({ error: 'expected YYYY-MM' });
    }
    const explicitlyOpened = (req.query as { open?: string }).open === '1';

    let budget = db.select().from(budgets).where(eq(budgets.month, month)).get();
    if (!budget) {
      if (month !== currentMonth() && !explicitlyOpened) {
        return { month, uncreated: true as const };
      }
      budget = materializeMonth(db, month, currentMonth()).budget;
    }

    const reconciliation = reconcileMonth(db, budget.id, month);
    return {
      month: budget.month,
      budgetId: budget.id,
      note: budget.note,
      lines: reconciliation.lines.map((line) => ({
        ...serializeBudgetLine(line),
        actualCents: line.actualCents,
        varianceCents: line.varianceCents,
        pending: line.pending,
      })),
      categories: reconciliation.categories,
      unbudgeted: reconciliation.unbudgeted,
      needsReview: reconciliation.needsReview,
      envelopeCandidates: envelopeCandidates(db, budget.id, month),
      totals: reconciliation.totals,
      // The "did I budget this month?" signal decision 003-K exists to protect.
      budgeted: reconciliation.lines.some((l) => l.kind === 'envelope'),
    };
  });

  app.post('/api/budgets', async (req, reply) => {
    const parsed = zBudgetCreate.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }
    const { budget, created } = materializeMonth(db, parsed.data.month, currentMonth());
    const lines = await db.select().from(budgetLines).where(eq(budgetLines.budgetId, budget.id));
    // Re-materializing is a no-op rather than an error: the caller asked for the
    // month to exist, and it does. 200 vs 201 distinguishes the two.
    return reply.code(created ? 201 : 200).send({
      month: budget.month,
      budgetId: budget.id,
      note: budget.note,
      lines: lines.map(serializeBudgetLine),
    });
  });

  app.patch('/api/budgets/:month', async (req, reply) => {
    const month = (req.params as { month: string }).month;
    const parsed = zBudgetPatch.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }
    const existing = db.select().from(budgets).where(eq(budgets.month, month)).get();
    if (!existing) {
      return reply.code(404).send({ error: 'budget month not materialized' });
    }
    const row = db
      .update(budgets)
      .set({ note: parsed.data.note })
      .where(eq(budgets.month, month))
      .returning()
      .get();
    return { month: row.month, budgetId: row.id, note: row.note };
  });

  /**
   * The budget-making screen's single save. **Upsert with partial-save
   * semantics**: a listed `amountCents: null` deletes that category's envelope,
   * and categories **omitted** from the array are left untouched — a screen that
   * rendered a subset can never silently wipe envelopes it did not show.
   */
  app.put('/api/budgets/:month/envelopes', async (req, reply) => {
    const month = (req.params as { month: string }).month;
    if (!zMonth.safeParse(month).success) {
      return reply.code(400).send({ error: 'expected YYYY-MM' });
    }
    const parsed = zEnvelopesPut.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }

    const { budget } = materializeMonth(db, month, currentMonth());
    const categoryRows = new Map(
      db
        .select()
        .from(categories)
        .all()
        .map((c) => [c.id, c]),
    );

    // Validate the WHOLE payload before writing anything: a partial save is a
    // partial *selection* of categories, not a partially-applied request.
    for (const entry of parsed.data.envelopes) {
      const category = categoryRows.get(entry.categoryId);
      if (!category) {
        return reply.code(400).send({ error: `category ${entry.categoryId} not found` });
      }
      if (category.systemKey === 'transfer' || category.isIncomeSource) {
        return reply.code(400).send({
          error: `"${category.name}" cannot hold an envelope`,
          hint: 'Transfer and income-source categories are outside the reconciliation set; budgets plan expenses only',
        });
      }
      const existing = findEnvelopeForCategory(db, budget.id, entry.categoryId);
      // Creating on an archived category is rejected, symmetric with the screen
      // omitting archived categories. Updating or deleting an existing envelope
      // stays allowed, so a category archived mid-month doesn't strand its
      // envelope.
      if (category.archivedAt !== null && !existing && entry.amountCents !== null) {
        return reply.code(400).send({
          error: `"${category.name}" is archived and cannot be given a new envelope`,
          hint: 'unarchive the category first; existing envelopes on it can still be edited or removed',
        });
      }
    }

    // One transaction: the payload was validated as a whole, so it must apply as
    // a whole. A mid-loop failure that left some categories saved would report a
    // 500 while having silently changed the month's plan.
    const existingByCategory = new Map(
      parsed.data.envelopes.map((entry) => [
        entry.categoryId,
        findEnvelopeForCategory(db, budget.id, entry.categoryId),
      ]),
    );

    db.transaction((tx) => {
      for (const entry of parsed.data.envelopes) {
        const existing = existingByCategory.get(entry.categoryId);
        if (entry.amountCents === null) {
          if (existing) tx.delete(budgetLines).where(eq(budgetLines.id, existing.id)).run();
          continue;
        }
        if (existing) {
          tx.update(budgetLines)
            .set({ amountCents: entry.amountCents, updatedAt: new Date() })
            .where(eq(budgetLines.id, existing.id))
            .run();
          continue;
        }
        tx.insert(budgetLines)
          .values({
            budgetId: budget.id,
            kind: 'envelope',
            name: categoryRows.get(entry.categoryId)!.name,
            categoryId: entry.categoryId,
            amountCents: entry.amountCents,
          })
          .run();
      }
    });

    const lines = await db.select().from(budgetLines).where(eq(budgetLines.budgetId, budget.id));
    return { month: budget.month, budgetId: budget.id, lines: lines.map(serializeBudgetLine) };
  });

  app.post('/api/budgets/:month/lines', async (req, reply) => {
    const month = (req.params as { month: string }).month;
    if (!zMonth.safeParse(month).success) {
      return reply.code(400).send({ error: 'expected YYYY-MM' });
    }
    const parsed = zBudgetLineCreate.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'validation',
        hint: adhocHint(req.body),
        details: parsed.error.flatten(),
      });
    }
    const body = parsed.data;

    const { budget } = materializeMonth(db, month, currentMonth());
    const failure = validateLine(db, {
      budgetId: budget.id,
      categoryId: body.categoryId,
      kind: body.kind,
      matchKey: body.kind === 'adhoc' ? body.matchNormalizedCounterparty : null,
      excludeLineId: null,
    });
    if (failure) return reply.code(failure.status).send(failure.body);

    const row = db
      .insert(budgetLines)
      .values(
        body.kind === 'adhoc'
          ? {
              budgetId: budget.id,
              kind: 'adhoc',
              name: body.name,
              categoryId: body.categoryId,
              amountCents: body.amountCents,
              expectedDayOfMonth: body.expectedDayOfMonth ?? null,
              matchNormalizedCounterparty: body.matchNormalizedCounterparty,
              note: body.note ?? null,
            }
          : {
              budgetId: budget.id,
              kind: 'envelope',
              name: body.name ?? categoryName(db, body.categoryId),
              categoryId: body.categoryId,
              amountCents: body.amountCents,
              note: body.note ?? null,
            },
      )
      .returning()
      .get();

    return reply.code(201).send(serializeBudgetLine(row));
  });

  app.patch('/api/budgets/:month/lines/:id', async (req, reply) => {
    const { month, id: rawId } = req.params as { month: string; id: string };
    const id = Number(rawId);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    const parsed = zBudgetLinePatch.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }
    const patch = parsed.data;

    const existing = findLineInMonth(db, month, id);
    if (!existing) {
      return reply.code(404).send({ error: 'budget line not found' });
    }

    // The per-kind invariant table holds on PATCH exactly as on POST, so a patch
    // can never reach a state the corresponding POST would have rejected.
    if (existing.kind === 'envelope') {
      if (patch.matchNormalizedCounterparty != null) {
        return reply.code(400).send({
          error: 'an envelope cannot have a match key',
          hint: 'an envelope reconciles against its whole category; to plan a specific charge, add a one-off line instead',
        });
      }
      if (patch.expectedDayOfMonth != null) {
        return reply.code(400).send({ error: 'an envelope cannot have an expected day' });
      }
    } else if ('matchNormalizedCounterparty' in patch && patch.matchNormalizedCounterparty === null) {
      return reply.code(400).send({
        error: `a ${existing.kind} line cannot have its match key cleared`,
        hint: 'a line without a counterparty is a goal — raise the category envelope instead',
      });
    }

    const nextCategoryId = patch.categoryId ?? existing.categoryId;
    const nextMatchKey =
      patch.matchNormalizedCounterparty ?? existing.matchNormalizedCounterparty;
    const failure = validateLine(db, {
      budgetId: existing.budgetId,
      categoryId: nextCategoryId,
      kind: existing.kind,
      matchKey: nextMatchKey,
      excludeLineId: id,
    });
    if (failure) return reply.code(failure.status).send(failure.body);

    const row = db
      .update(budgetLines)
      .set({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.categoryId !== undefined && { categoryId: patch.categoryId }),
        ...(patch.amountCents !== undefined && { amountCents: patch.amountCents }),
        // Clamped exactly as on materialization (decision 003-A) — a patch must
        // not be able to store a day the month does not have.
        ...('expectedDayOfMonth' in patch && {
          expectedDayOfMonth:
            patch.expectedDayOfMonth == null
              ? patch.expectedDayOfMonth
              : clampDayToMonth(patch.expectedDayOfMonth, month),
        }),
        ...(patch.matchNormalizedCounterparty !== undefined && {
          matchNormalizedCounterparty: patch.matchNormalizedCounterparty,
        }),
        ...('note' in patch && { note: patch.note }),
        updatedAt: new Date(),
      })
      .where(eq(budgetLines.id, id))
      .returning()
      .get();

    return serializeBudgetLine(row);
  });

  app.delete('/api/budgets/:month/lines/:id', async (req, reply) => {
    const { month, id: rawId } = req.params as { month: string; id: string };
    const id = Number(rawId);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    const existing = findLineInMonth(db, month, id);
    if (!existing) {
      return reply.code(404).send({ error: 'budget line not found' });
    }
    // Durable by design (review Q2): the month row survives, so re-materializing
    // will not bring a deleted recurring line back.
    db.delete(budgetLines).where(eq(budgetLines.id, id)).run();
    return reply.code(204).send();
  });

  /**
   * Insert a template's snapshot into an already-materialized month (review Q1).
   *
   * This is an **ordinary line insert** running the same validation as
   * `POST …/lines` — in particular the one-line-per-match-key check. There is no
   * privileged path that writes lines around the invariants (decision 003-N), so
   * if the month already holds a line with that key this returns 409 and the
   * user reconciles the two by hand.
   */
  app.post('/api/budgets/:month/lines/from-template/:templateId', async (req, reply) => {
    const month = (req.params as { month: string }).month;
    const templateId = Number((req.params as { templateId: string }).templateId);
    if (!zMonth.safeParse(month).success || !Number.isInteger(templateId)) {
      return reply.code(400).send({ error: 'invalid month or template id' });
    }
    const template = db
      .select()
      .from(recurringTemplates)
      .where(eq(recurringTemplates.id, templateId))
      .get();
    if (!template) {
      return reply.code(404).send({ error: 'recurring template not found' });
    }
    const budget = db.select().from(budgets).where(eq(budgets.month, month)).get();
    if (!budget) {
      return reply.code(404).send({ error: 'budget month not materialized' });
    }
    if (!isTemplateDue(template, month)) {
      return reply.code(400).send({ error: `template is not due in ${month}` });
    }
    // Same window `addableToMonths` offers. A closed past month is the
    // historical record of what was planned then; a template created today does
    // not retroactively become part of it.
    if (month < currentMonth()) {
      return reply.code(400).send({
        error: `${month} is closed and cannot take new lines`,
        hint: 'past months are a historical record; add the line to the current month or later',
      });
    }

    const failure = validateLine(db, {
      budgetId: budget.id,
      categoryId: template.categoryId,
      kind: 'recurring',
      matchKey: template.matchNormalizedCounterparty,
      excludeLineId: null,
    });
    if (failure) return reply.code(failure.status).send(failure.body);

    const row = db.insert(budgetLines).values(snapshotLine(budget.id, template, month)).returning().get();
    return reply.code(201).send(serializeBudgetLine(row));
  });
}

/**
 * A line resolved **within the month that addresses it**. Resolving by `id`
 * alone would let `DELETE /api/budgets/2025-08/lines/:id` destroy a line
 * belonging to 2026-05 — already-materialized months are a historical record,
 * and line deletion is durable by design, so a cross-month write is
 * unrecoverable. A line addressed through the wrong month is simply not found.
 */
function findLineInMonth(
  db: Db,
  month: string,
  id: number,
): typeof budgetLines.$inferSelect | undefined {
  const budget = db.select().from(budgets).where(eq(budgets.month, month)).get();
  if (!budget) return undefined;
  return db
    .select()
    .from(budgetLines)
    .where(and(eq(budgetLines.id, id), eq(budgetLines.budgetId, budget.id)))
    .get();
}

/**
 * The invariants every line insert/patch must satisfy, in one place so the
 * targeted insert cannot drift from `POST …/lines`.
 */
function validateLine(
  db: Db,
  opts: {
    budgetId: number;
    categoryId: number;
    kind: 'recurring' | 'adhoc' | 'envelope';
    matchKey: string | null;
    excludeLineId: number | null;
  },
): { status: number; body: Record<string, unknown> } | undefined {
  const category = db.select().from(categories).where(eq(categories.id, opts.categoryId)).get();
  if (!category) {
    return { status: 400, body: { error: 'category not found' } };
  }
  if (category.systemKey === 'transfer' || category.isIncomeSource) {
    return {
      status: 400,
      body: {
        error: `"${category.name}" cannot hold a budget line`,
        hint: 'Transfer and income-source categories are outside the reconciliation set',
      },
    };
  }

  if (opts.matchKey !== null) {
    // At most one line per match key per month (003-G): two named lines on one
    // key would both sum the same transactions, and "consumed" only
    // disambiguates them under a processing order that deliberately does not
    // exist.
    const clash = findLineByMatchKey(db, opts.budgetId, opts.matchKey);
    if (clash && clash.id !== opts.excludeLineId) {
      return {
        status: 409,
        body: {
          error: `this month already has a line matching "${opts.matchKey}" ("${clash.name}")`,
          hint: 'edit that line instead, or delete it first',
          conflictingLine: { id: clash.id, name: clash.name, kind: clash.kind },
        },
      };
    }
    return undefined;
  }

  // At most one envelope per category per month (003-B, restated by 003-I): an
  // envelope reconciles against a whole category, so two competing for the same
  // remainder would be ambiguous.
  const clash = findEnvelopeForCategory(db, opts.budgetId, opts.categoryId);
  if (clash && clash.id !== opts.excludeLineId) {
    return {
      status: 409,
      body: {
        error: `"${category.name}" already has an envelope this month`,
        hint: 'edit the existing envelope, or give the new line a matchNormalizedCounterparty so it consumes only its own charges',
        conflictingLine: { id: clash.id, name: clash.name, kind: clash.kind },
      },
    };
  }
  return undefined;
}

/** Steer a keyless ad-hoc attempt to the raised-envelope expression (003-J). */
function adhocHint(body: unknown): string | undefined {
  const kind = (body as { kind?: unknown } | null)?.kind;
  if (kind !== 'adhoc') return undefined;
  return 'a one-off line needs matchNormalizedCounterparty; a planned one-off with no known counterparty is a raised category envelope plus a note (e.g. Transport 550, note "incl. car service")';
}

function categoryName(db: Db, categoryId: number): string {
  return db.select().from(categories).where(eq(categories.id, categoryId)).get()?.name ?? 'Envelope';
}

/**
 * One entry per envelope-relevant category, for the budget-making screen.
 *
 * `suggestedAmountCents` is that category's envelope in the **immediately
 * preceding** calendar month — no deeper lookback, so the first month ever is
 * entirely blank. It is **data for rendering, never a line** (decision 003-K):
 * nothing here creates an envelope, because auto-created envelopes would make
 * every month look budgeted and destroy the "did I budget this month?" signal.
 *
 * The screen's per-category planned subtotal is NOT returned here: it has to
 * update live as the owner types a goal, so it is computed on the client from
 * the month's lines. `categories` carries the committed decomposition.
 */
function envelopeCandidates(
  db: Db,
  budgetId: number,
  month: string,
): {
  categoryId: number;
  envelopeAmountCents: number | null;
  suggestedAmountCents: number | null;
}[] {
  const previous = db.select().from(budgets).where(eq(budgets.month, previousMonth(month))).get();
  const previousEnvelopes = previous
    ? new Map(
        db
          .select()
          .from(budgetLines)
          .where(eq(budgetLines.budgetId, previous.id))
          .all()
          .filter((l) => l.kind === 'envelope')
          .map((l) => [l.categoryId, l.amountCents]),
      )
    : new Map<number, number>();

  const lines = db.select().from(budgetLines).where(eq(budgetLines.budgetId, budgetId)).all();
  const envelopes = new Map(
    lines.filter((l) => l.kind === 'envelope').map((l) => [l.categoryId, l.amountCents]),
  );

  return envelopeRelevantCategories(db)
    // Archived categories are omitted unless they already hold an **envelope**
    // this month. The predicate must match `PUT …/envelopes` exactly: keying it
    // on any line would offer a goal input for an archived category that only
    // holds a materialized bill, and the save would then 400 — discarding every
    // other goal in the same payload, since validation covers the whole request.
    .filter((c) => c.archivedAt === null || envelopes.has(c.id))
    .map((c) => ({
      categoryId: c.id,
      envelopeAmountCents: envelopes.get(c.id) ?? null,
      suggestedAmountCents: previousEnvelopes.get(c.id) ?? null,
    }));
}
