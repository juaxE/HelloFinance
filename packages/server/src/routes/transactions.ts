import type { FastifyInstance } from 'fastify';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import { zTransactionPatch } from '@finance/shared';
import type { Db } from '../db/client';
import { labelingRules, transactions } from '../db/schema';
import { normalizeCounterparty } from '../import/normalize';
import { serializeTransaction } from './serialize';

/**
 * Committed transactions: listing (not in spec 002's enumerated API surface,
 * but needed for any UI to show/edit what got imported) and relabel/annotate
 * (spec 002 "Relabeling / annotating a committed transaction").
 */
export function registerTransactionRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/transactions', async (req) => {
    const query = req.query as { accountId?: string; importId?: string };
    const conditions: SQL[] = [];
    if (query.accountId !== undefined) {
      conditions.push(eq(transactions.accountId, Number(query.accountId)));
    }
    if (query.importId !== undefined) {
      conditions.push(eq(transactions.importId, Number(query.importId)));
    }

    const rows = await db
      .select()
      .from(transactions)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(transactions.paymentDate), desc(transactions.id));
    return rows.map(serializeTransaction);
  });

  app.patch('/api/transactions/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    const parsed = zTransactionPatch.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }
    const patch = parsed.data;

    const [existing] = await db.select().from(transactions).where(eq(transactions.id, id));
    if (!existing) {
      return reply.code(404).send({ error: 'transaction not found' });
    }

    // 'update_rule' also upserts the labeling rule for this transaction's
    // normalized counterparty; 'one_off' touches only this row. 'manual'
    // always wins over any rule on future imports (non-negotiable #4 domain
    // rule — see spec 002).
    if (patch.categoryId !== undefined && patch.scope === 'update_rule') {
      await db
        .insert(labelingRules)
        .values({
          normalizedCounterparty: normalizeCounterparty(existing.counterparty),
          categoryId: patch.categoryId,
          exampleRaw: existing.counterparty,
        })
        .onConflictDoUpdate({
          target: labelingRules.normalizedCounterparty,
          set: { categoryId: patch.categoryId, updatedAt: new Date() },
        });
    }

    const [row] = await db
      .update(transactions)
      .set({
        ...(patch.categoryId !== undefined && {
          categoryId: patch.categoryId,
          categorySource: 'manual' as const,
        }),
        ...('note' in patch && { note: patch.note }),
        updatedAt: new Date(),
      })
      .where(eq(transactions.id, id))
      .returning();
    return serializeTransaction(row!);
  });
}
