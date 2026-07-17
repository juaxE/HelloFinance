import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { openingBalanceIsConsistent, zAccountCreate, zAccountPatch } from '@finance/shared';
import type { Db } from '../db/client';
import { accounts } from '../db/schema';
import { normalizeIban, serializeAccount } from './serialize';

/**
 * Reference resource: bank accounts (spec 001). No auth — the server is
 * loopback-only. Opening balance + date carry the derived-balance semantics of
 * decision 001-A; the non-zero-balance-needs-a-date invariant is enforced on
 * both create and (merged) patch.
 */
export function registerAccountRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/accounts', async () => {
    const rows = await db.select().from(accounts).orderBy(accounts.id);
    return rows.map(serializeAccount);
  });

  app.post('/api/accounts', async (req, reply) => {
    const parsed = zAccountCreate.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }
    const body = parsed.data;
    const [row] = await db
      .insert(accounts)
      .values({
        name: body.name,
        kind: body.kind ?? 'main',
        iban: body.iban ? normalizeIban(body.iban) : null,
        openingBalanceCents: body.openingBalanceCents ?? 0,
        openingBalanceDate: body.openingBalanceDate ?? null,
      })
      .returning();
    return reply.code(201).send(serializeAccount(row!));
  });

  app.patch('/api/accounts/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    const parsed = zAccountPatch.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }
    const patch = parsed.data;

    const [existing] = await db.select().from(accounts).where(eq(accounts.id, id));
    if (!existing) {
      return reply.code(404).send({ error: 'account not found' });
    }

    // Enforce decision 001-A against the merged state, since either field may be
    // absent from the patch.
    const mergedCents = patch.openingBalanceCents ?? existing.openingBalanceCents;
    const mergedDate =
      'openingBalanceDate' in patch
        ? (patch.openingBalanceDate ?? null)
        : existing.openingBalanceDate;
    if (!openingBalanceIsConsistent(mergedCents, mergedDate)) {
      return reply.code(400).send({
        error: 'validation',
        message: 'opening_balance_cents must be 0 when opening_balance_date is null',
      });
    }

    const [row] = await db
      .update(accounts)
      .set({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.kind !== undefined && { kind: patch.kind }),
        ...('iban' in patch && { iban: patch.iban ? normalizeIban(patch.iban) : null }),
        ...(patch.openingBalanceCents !== undefined && {
          openingBalanceCents: patch.openingBalanceCents,
        }),
        ...('openingBalanceDate' in patch && { openingBalanceDate: patch.openingBalanceDate }),
      })
      .where(eq(accounts.id, id))
      .returning();
    return serializeAccount(row!);
  });
}
