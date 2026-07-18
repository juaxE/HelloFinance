import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';
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
    // normalized counterparty AND retroactively relabels the rows the rule had
    // already (mis)labeled; 'one_off' touches only this row. The edited row
    // itself is a direct user choice → 'manual' (always wins over any rule on
    // future imports — non-negotiable #4). See spec 002 "Relabeling".
    let relabeledCount = 0;
    if (patch.categoryId !== undefined && patch.scope === 'update_rule') {
      const targetNormalized = normalizeCounterparty(existing.counterparty);
      await db
        .insert(labelingRules)
        .values({
          normalizedCounterparty: targetNormalized,
          categoryId: patch.categoryId,
          exampleRaw: existing.counterparty,
        })
        .onConflictDoUpdate({
          target: labelingRules.normalizedCounterparty,
          set: { categoryId: patch.categoryId, updatedAt: new Date() },
        });

      // Retroactive: every OTHER committed transaction sharing this normalized
      // counterparty whose category came from a rule follows the corrected rule.
      // `manual` / `type_hint` / uncategorized rows are never rewritten, and the
      // edited row is handled separately below. `transactions` stores no
      // normalized column, so normalize each rule-sourced row's counterparty.
      const siblingIds = (
        await db.select().from(transactions).where(eq(transactions.categorySource, 'rule'))
      )
        .filter((t) => t.id !== id && normalizeCounterparty(t.counterparty) === targetNormalized)
        .map((t) => t.id);
      if (siblingIds.length > 0) {
        await db
          .update(transactions)
          .set({ categoryId: patch.categoryId, updatedAt: new Date() })
          .where(inArray(transactions.id, siblingIds));
        relabeledCount = siblingIds.length;
      }
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
    return { transaction: serializeTransaction(row!), relabeledCount };
  });
}
