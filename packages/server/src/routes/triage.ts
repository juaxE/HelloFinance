import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { zTriageGroupApply, zTriageUndo } from '@finance/shared';
import type { Db } from '../db/client';
import {
  TriageError,
  type TriageUndoRecord,
  applyTriageGroup,
  countUncategorized,
  listTriageQueue,
  undoTriageApply,
} from '../triage/queue';

/**
 * Triage of committed-but-uncategorized transactions.
 *
 * These are new endpoints rather than a flag on `PATCH /api/transactions/:id`
 * because that route's retroactive sweep filters on
 * `category_source = 'rule'`, and `ck_transactions_category_source` forces the
 * source null for exactly the rows triage targets. It is structurally unable to
 * see them.
 */
export function registerTriageRoutes(app: FastifyInstance, db: Db): void {
  /**
   * The one undoable apply. Held in this closure rather than module scope so
   * every `buildApp` — including each test's — gets its own, and deliberately
   * not persisted: undo exists to make a misclick on "apply to all 43"
   * recoverable in the working session, not as an audit trail.
   */
  let undoSlot: { token: string; undo: TriageUndoRecord } | null = null;

  app.get('/api/transactions/uncategorized', async () => listTriageQueue(db));

  app.get('/api/transactions/uncategorized/count', async () => ({
    count: countUncategorized(db),
  }));

  app.post('/api/transactions/triage/group', async (req, reply) => {
    const parsed = zTriageGroupApply.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }
    try {
      const { appliedCount, source, undo } = applyTriageGroup(db, parsed.data);
      const token = randomUUID();
      undoSlot = { token, undo };
      return { appliedCount, source, ruleCreated: undo.ruleId !== null, undoToken: token };
    } catch (err) {
      if (err instanceof TriageError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post('/api/transactions/triage/undo', async (req, reply) => {
    const parsed = zTriageUndo.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }
    if (!undoSlot || undoSlot.token !== parsed.data.undoToken) {
      return reply.code(409).send({ error: 'nothing to undo' });
    }
    const result = undoTriageApply(db, undoSlot.undo);
    undoSlot = null;
    return result;
  });
}
