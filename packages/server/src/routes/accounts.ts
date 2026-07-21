import type { FastifyInstance } from 'fastify';
import { and, count, eq, lt, min } from 'drizzle-orm';
import { openingBalanceIsConsistent, zAccountCreate, zAccountPatch } from '@finance/shared';
import type { Db } from '../db/client';
import { accounts, transactions } from '../db/schema';
import { reanalyzeStagedBeforeOpening } from '../import/pipeline';
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

    // Read, guard and write in one transaction: the merged state is derived from
    // the existing row, so a concurrent opening-date edit or import commit
    // between the read and the write would let a stale merged state through.
    const result = db.transaction((tx) => {
      const existing = tx.select().from(accounts).where(eq(accounts.id, id)).get();
      if (existing === undefined) {
        return { kind: 'not_found' as const };
      }

      // Enforce decision 001-A against the merged state, since either field may
      // be absent from the patch.
      const mergedCents = patch.openingBalanceCents ?? existing.openingBalanceCents;
      const mergedDate =
        'openingBalanceDate' in patch
          ? (patch.openingBalanceDate ?? null)
          : existing.openingBalanceDate;
      if (!openingBalanceIsConsistent(mergedCents, mergedDate)) {
        return { kind: 'inconsistent' as const };
      }

      const dateMoves = mergedDate !== existing.openingBalanceDate;
      // Moving the anchor forward past committed rows silently shrinks the
      // balance window (`balance(D) = opening + Σ amount WHERE
      // opening_balance_date ≤ payment_date ≤ D`) and corrupts every derived
      // balance. Conflict with committed data ⇒ 409, not 400. Setting a date for
      // the first time on an account that already has older rows is the same
      // corruption, same answer.
      if (dateMoves && mergedDate !== null) {
        const dropped = tx
          .select({ n: count(), earliest: min(transactions.paymentDate) })
          .from(transactions)
          .where(and(eq(transactions.accountId, id), lt(transactions.paymentDate, mergedDate)))
          .get();
        if (dropped !== undefined && dropped.n > 0) {
          return {
            kind: 'conflict' as const,
            n: dropped.n,
            earliest: dropped.earliest,
            mergedDate,
          };
        }
      }

      const updated = tx
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
        .returning()
        .get();

      // `before_opening` on staged rows was frozen at analyze time against the
      // old date; an import still in review would otherwise commit rows on the
      // wrong side of the new boundary — the same re-analysis `extendHistory`
      // performs when it moves the date the other way.
      if (dateMoves) {
        reanalyzeStagedBeforeOpening(tx, id, mergedDate);
      }
      return { kind: 'ok' as const, row: updated };
    });

    if (result.kind === 'not_found') {
      return reply.code(404).send({ error: 'account not found' });
    }
    if (result.kind === 'inconsistent') {
      return reply.code(400).send({
        error: 'validation',
        message: 'opening_balance_cents must be 0 when opening_balance_date is null',
      });
    }
    if (result.kind === 'conflict') {
      const { n, earliest, mergedDate } = result;
      return reply.code(409).send({
        error: 'opening balance date would drop committed transactions',
        message: `${n} committed transaction(s) are dated before ${mergedDate}, the earliest on ${earliest}`,
        hint: 'keep the opening balance date at or before the earliest committed payment date; moving the anchor forward would require recomputing the opening balance by hand',
        earliestPaymentDate: earliest,
        droppedCount: n,
      });
    }
    return serializeAccount(result.row!);
  });
}
