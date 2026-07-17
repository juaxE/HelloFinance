import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { zLabelingRulePatch } from '@finance/shared';
import type { Db } from '../db/client';
import { labelingRules } from '../db/schema';
import { serializeLabelingRule } from './serialize';

/** Rules management (spec 002 Settings screen): list, retarget, delete. */
export function registerLabelingRuleRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/labeling-rules', async () => {
    const rows = await db
      .select()
      .from(labelingRules)
      .orderBy(asc(labelingRules.normalizedCounterparty));
    return rows.map(serializeLabelingRule);
  });

  app.patch('/api/labeling-rules/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    const parsed = zLabelingRulePatch.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }

    const [existing] = await db.select().from(labelingRules).where(eq(labelingRules.id, id));
    if (!existing) {
      return reply.code(404).send({ error: 'labeling rule not found' });
    }

    const [row] = await db
      .update(labelingRules)
      .set({ categoryId: parsed.data.categoryId, updatedAt: new Date() })
      .where(eq(labelingRules.id, id))
      .returning();
    return serializeLabelingRule(row!);
  });

  app.delete('/api/labeling-rules/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    const [existing] = await db.select().from(labelingRules).where(eq(labelingRules.id, id));
    if (!existing) {
      return reply.code(404).send({ error: 'labeling rule not found' });
    }
    await db.delete(labelingRules).where(eq(labelingRules.id, id));
    return reply.code(204).send();
  });
}
