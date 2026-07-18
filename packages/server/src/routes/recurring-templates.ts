import type { FastifyInstance } from 'fastify';
import { and, asc, eq, ne } from 'drizzle-orm';
import { zRecurringTemplateCreate, zRecurringTemplatePatch } from '@finance/shared';
import type { Db } from '../db/client';
import { budgetLines, budgets, categories, recurringTemplates } from '../db/schema';
import { isTemplateDue, isTemplateEnded } from '../budgets/months';
import { serializeRecurringTemplate } from './serialize';

type TemplateRow = typeof recurringTemplates.$inferSelect;

/**
 * Recurring templates — the **bill** plan source (spec 003). Three rules carry
 * most of the weight here:
 *
 *  - **003-L**: every template must carry a `matchNormalizedCounterparty`.
 *    Anything without a counterparty is a goal, and goals are envelopes.
 *  - **003-N**: that key is unique across **non-ended** templates. Two templates
 *    on one counterparty would materialize two same-key lines into every month,
 *    through a path that never checks the one-line-per-key invariant. Enforcing
 *    uniqueness here makes the collision unreachable by construction.
 *  - **003-H**: retire with `end_month`, don't delete. `budget_lines.template_id`
 *    has no `ON DELETE` behavior and foreign keys are on, so deleting a
 *    materialized template would fail at the FK anyway; ending also preserves
 *    line provenance, which a `SET NULL` would erase.
 */
export function registerRecurringTemplateRoutes(
  app: FastifyInstance,
  db: Db,
  currentMonth: () => string,
): void {
  app.get('/api/recurring-templates', async () => {
    const rows = await db
      .select()
      .from(recurringTemplates)
      .orderBy(asc(recurringTemplates.name), asc(recurringTemplates.id));
    return rows.map(serializeRecurringTemplate);
  });

  app.post('/api/recurring-templates', async (req, reply) => {
    const parsed = zRecurringTemplateCreate.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'validation',
        // 003-L: the absent-key case is the likely one, and a bare validation
        // dump would not tell the owner what to do instead.
        hint: 'a template is a bill and needs matchNormalizedCounterparty; a goal with no counterparty is a category envelope, set on the budget-making screen',
        details: parsed.error.flatten(),
      });
    }
    const body = parsed.data;

    const categoryError = await assertUsableCategory(db, body.categoryId);
    if (categoryError) return reply.code(400).send(categoryError);

    const collision = await findKeyCollision(db, {
      matchKey: body.matchNormalizedCounterparty,
      endMonth: body.endMonth ?? null,
      currentMonth: currentMonth(),
      excludeId: null,
    });
    if (collision) return reply.code(409).send(keyCollisionError(collision));

    const row = db
      .insert(recurringTemplates)
      .values({
        name: body.name,
        categoryId: body.categoryId,
        amountCents: body.amountCents,
        intervalMonths: body.intervalMonths,
        expectedDayOfMonth: body.expectedDayOfMonth,
        startMonth: body.startMonth,
        endMonth: body.endMonth ?? null,
        matchNormalizedCounterparty: body.matchNormalizedCounterparty,
        note: body.note ?? null,
      })
      .returning()
      .get();

    return reply.code(201).send({
      ...serializeRecurringTemplate(row),
      addableToMonths: await addableToMonths(db, row, currentMonth()),
    });
  });

  app.patch('/api/recurring-templates/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    const parsed = zRecurringTemplatePatch.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'validation',
        hint: 'matchNormalizedCounterparty cannot be cleared — a template without a counterparty would be a goal, which is a category envelope (003-L)',
        details: parsed.error.flatten(),
      });
    }
    const patch = parsed.data;

    const existing = db.select().from(recurringTemplates).where(eq(recurringTemplates.id, id)).get();
    if (!existing) {
      return reply.code(404).send({ error: 'recurring template not found' });
    }

    if (patch.categoryId !== undefined) {
      const categoryError = await assertUsableCategory(db, patch.categoryId);
      if (categoryError) return reply.code(400).send(categoryError);
    }

    // Check the key against the template's *post-patch* state: retargeting the
    // key, or extending an ended template back into the live set, both need the
    // uniqueness check that the unpatched row would have passed.
    const nextKey = patch.matchNormalizedCounterparty ?? existing.matchNormalizedCounterparty;
    const nextEndMonth = patch.endMonth !== undefined ? patch.endMonth : existing.endMonth;
    if (nextKey !== null) {
      const collision = await findKeyCollision(db, {
        matchKey: nextKey,
        endMonth: nextEndMonth,
        currentMonth: currentMonth(),
        excludeId: id,
      });
      if (collision) return reply.code(409).send(keyCollisionError(collision));
    }

    const row = db
      .update(recurringTemplates)
      .set({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.categoryId !== undefined && { categoryId: patch.categoryId }),
        ...(patch.amountCents !== undefined && { amountCents: patch.amountCents }),
        ...(patch.intervalMonths !== undefined && { intervalMonths: patch.intervalMonths }),
        ...(patch.expectedDayOfMonth !== undefined && {
          expectedDayOfMonth: patch.expectedDayOfMonth,
        }),
        ...(patch.startMonth !== undefined && { startMonth: patch.startMonth }),
        ...('endMonth' in patch && { endMonth: patch.endMonth }),
        ...(patch.matchNormalizedCounterparty !== undefined && {
          matchNormalizedCounterparty: patch.matchNormalizedCounterparty,
        }),
        ...('note' in patch && { note: patch.note }),
        updatedAt: new Date(),
      })
      .where(eq(recurringTemplates.id, id))
      .returning()
      .get();

    return {
      ...serializeRecurringTemplate(row),
      addableToMonths: await addableToMonths(db, row, currentMonth()),
    };
  });

  app.delete('/api/recurring-templates/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    const existing = db.select().from(recurringTemplates).where(eq(recurringTemplates.id, id)).get();
    if (!existing) {
      return reply.code(404).send({ error: 'recurring template not found' });
    }

    const materialized = db
      .select({ id: budgetLines.id })
      .from(budgetLines)
      .where(eq(budgetLines.templateId, id))
      .get();
    if (materialized) {
      // 003-H — end, don't delete. Past months are a historical record and
      // their lines keep their provenance.
      return reply.code(409).send({
        error: 'template has materialized budget lines and cannot be deleted',
        hint: 'set endMonth to stop future materialization; past months keep their lines as a historical record',
        templateId: id,
      });
    }

    db.delete(recurringTemplates).where(eq(recurringTemplates.id, id)).run();
    return reply.code(204).send();
  });
}

/**
 * The key-uniqueness set (003-N) holds over **non-ended** templates only, so an
 * already-ended candidate is outside the set and cannot collide — symmetric with
 * the rule that an ended template does not block reusing its key.
 */
async function findKeyCollision(
  db: Db,
  opts: { matchKey: string; endMonth: string | null; currentMonth: string; excludeId: number | null },
): Promise<TemplateRow | undefined> {
  if (isTemplateEnded({ endMonth: opts.endMonth }, opts.currentMonth)) {
    return undefined;
  }
  const candidates = await db
    .select()
    .from(recurringTemplates)
    .where(
      opts.excludeId === null
        ? eq(recurringTemplates.matchNormalizedCounterparty, opts.matchKey)
        : and(
            eq(recurringTemplates.matchNormalizedCounterparty, opts.matchKey),
            ne(recurringTemplates.id, opts.excludeId),
          ),
    );
  return candidates.find((t) => !isTemplateEnded(t, opts.currentMonth));
}

/** A 409 that names the existing template, so the UI can link to it rather than dead-end. */
function keyCollisionError(existing: TemplateRow): Record<string, unknown> {
  return {
    error: `match key "${existing.matchNormalizedCounterparty}" is already used by the template "${existing.name}"`,
    hint: 'edit that template instead; two genuinely different bills from one counterparty are one template plus a category envelope',
    conflictingTemplate: { id: existing.id, name: existing.name },
  };
}

/**
 * Months that already exist and are **current or future**, where this template
 * is now due (review Q1). Already-closed past months are left alone as the
 * historical record. Acting on the hint is an ordinary line insert and runs the
 * same validation as `POST …/lines` — it can itself 409 (decision 003-N).
 */
async function addableToMonths(db: Db, template: TemplateRow, current: string): Promise<string[]> {
  const rows = await db.select({ month: budgets.month }).from(budgets);
  return rows
    .map((r) => r.month)
    .filter((month) => month >= current && isTemplateDue(template, month))
    .sort();
}

/** Templates plan expenses: income-source and Transfer categories are not budgetable. */
async function assertUsableCategory(
  db: Db,
  categoryId: number,
): Promise<Record<string, unknown> | undefined> {
  const category = db.select().from(categories).where(eq(categories.id, categoryId)).get();
  if (!category) {
    return { error: 'category not found' };
  }
  if (category.systemKey === 'transfer' || category.isIncomeSource) {
    return {
      error: 'Transfer and income-source categories cannot be budgeted',
      hint: 'budgets plan expenses only; income budgeting is deferred',
    };
  }
  return undefined;
}
