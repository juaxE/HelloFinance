import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { zCategoryCreate, zCategoryPatch } from '@finance/shared';
import type { Db } from '../db/client';
import { categories } from '../db/schema';
import { isUniqueViolation, serializeCategory } from './serialize';

/**
 * Reference resource: categories (spec 001). The two system built-ins
 * (Transfer, Income) are locked five ways: they cannot be deleted (no delete
 * endpoint exists), renamed, archived, have their `system_key` changed (not a
 * patchable field), or have their `is_income_source` flipped. Recolor/reorder
 * are allowed. Renaming is locked (decision 001-I) so a renamed Transfer can
 * never masquerade as an ordinary category while still being excluded from every
 * aggregate. `system_key` is never client-settable — POST only makes ordinary
 * categories.
 */
export function registerCategoryRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/categories', async () => {
    const rows = await db
      .select()
      .from(categories)
      .orderBy(asc(categories.sortOrder), asc(categories.id));
    return rows.map(serializeCategory);
  });

  app.post('/api/categories', async (req, reply) => {
    const parsed = zCategoryCreate.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }
    const body = parsed.data;
    try {
      const [row] = await db
        .insert(categories)
        .values({
          name: body.name,
          isIncomeSource: body.isIncomeSource ?? false,
          color: body.color ?? null,
          sortOrder: body.sortOrder ?? 0,
        })
        .returning();
      return reply.code(201).send(serializeCategory(row!));
    } catch (err) {
      if (isUniqueViolation(err)) {
        return reply.code(409).send({ error: 'a category with that name already exists' });
      }
      throw err;
    }
  });

  app.patch('/api/categories/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    const parsed = zCategoryPatch.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }
    const patch = parsed.data;

    const [existing] = await db.select().from(categories).where(eq(categories.id, id));
    if (!existing) {
      return reply.code(404).send({ error: 'category not found' });
    }

    if (existing.systemKey !== null) {
      if (patch.name !== undefined && patch.name !== existing.name) {
        return reply.code(409).send({ error: 'system categories cannot be renamed' });
      }
      if (patch.archived === true) {
        return reply.code(409).send({ error: 'system categories cannot be archived' });
      }
      if (patch.isIncomeSource !== undefined && patch.isIncomeSource !== existing.isIncomeSource) {
        return reply
          .code(409)
          .send({ error: 'is_income_source is fixed for system categories' });
      }
    }

    try {
      const [row] = await db
        .update(categories)
        .set({
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.isIncomeSource !== undefined && { isIncomeSource: patch.isIncomeSource }),
          ...('color' in patch && { color: patch.color }),
          ...(patch.sortOrder !== undefined && { sortOrder: patch.sortOrder }),
          ...(patch.archived !== undefined && {
            archivedAt: patch.archived ? new Date() : null,
          }),
        })
        .where(eq(categories.id, id))
        .returning();
      return serializeCategory(row!);
    } catch (err) {
      if (isUniqueViolation(err)) {
        return reply.code(409).send({ error: 'a category with that name already exists' });
      }
      throw err;
    }
  });
}
