import type { FastifyInstance, FastifyReply } from 'fastify';
import { zCommitRequest, zGroupPatch, zImportStatus, zRowPatch } from '@finance/shared';
import type { Db } from '../db/client';
import { BankAdapterParseError } from '../import/adapter';
import {
  ImportPipelineError,
  analyzeImport,
  commitImport,
  discardImport,
  extendHistory,
  getImportDetail,
  listImports,
  updateGroup,
  updateRow,
} from '../import/pipeline';
import { serializeImport } from './serialize';

/**
 * CSV import & review pipeline (spec 002). Upload -> analyze (parse, dedup,
 * propose labels, stage) -> interactive review (bulk group edits, per-row
 * overrides) -> commit or discard. No auth (server is loopback-only).
 */
export function registerImportRoutes(app: FastifyInstance, db: Db): void {
  // Handles both ImportPipelineError (mapped to its own statusCode) and a
  // malformed upload (BankAdapterParseError -> 400). Returns true if it sent
  // a response, so the caller can `if (handled) return;`.
  function handleImportError(err: unknown, reply: FastifyReply): boolean {
    if (err instanceof ImportPipelineError) {
      reply.code(err.statusCode).send({ error: err.message });
      return true;
    }
    if (err instanceof BankAdapterParseError) {
      reply.code(400).send({ error: err.message });
      return true;
    }
    return false;
  }

  app.post('/api/imports', async (req, reply) => {
    let accountId: number | undefined;
    let filename: string | undefined;
    let bytes: Buffer | undefined;

    for await (const part of req.parts()) {
      if (part.type === 'file' && part.fieldname === 'file') {
        filename = part.filename;
        bytes = await part.toBuffer();
      } else if (part.type === 'field' && part.fieldname === 'accountId') {
        accountId = Number(part.value);
      }
    }

    if (!bytes || !filename) {
      return reply.code(400).send({ error: 'file is required' });
    }
    if (accountId === undefined || !Number.isInteger(accountId)) {
      return reply.code(400).send({ error: 'accountId is required' });
    }

    try {
      const { importId } = analyzeImport(db, { accountId, filename, bytes });
      return reply.code(201).send(getImportDetail(db, importId));
    } catch (err) {
      if (handleImportError(err, reply)) return;
      throw err;
    }
  });

  // The resume list: without it a review interrupted mid-way is unreachable
  // and its staged decisions are orphaned.
  app.get('/api/imports', async (req, reply) => {
    const { status } = req.query as { status?: string };
    if (status !== undefined) {
      const parsed = zImportStatus.safeParse(status);
      if (!parsed.success) {
        return reply.code(400).send({ error: `unknown status '${status}'` });
      }
      return listImports(db, parsed.data).map(serializeImport);
    }
    return listImports(db).map(serializeImport);
  });

  app.get('/api/imports/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    try {
      return getImportDetail(db, id);
    } catch (err) {
      if (handleImportError(err, reply)) return;
      throw err;
    }
  });

  app.patch('/api/imports/:id/groups/:normalizedCounterparty', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const normalizedCounterparty = decodeURIComponent(
      (req.params as { normalizedCounterparty: string }).normalizedCounterparty,
    );
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    const parsed = zGroupPatch.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }

    try {
      updateGroup(db, id, normalizedCounterparty, parsed.data);
      return getImportDetail(db, id);
    } catch (err) {
      if (handleImportError(err, reply)) return;
      throw err;
    }
  });

  app.patch('/api/imports/:id/rows/:rowId', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const rowId = Number((req.params as { rowId: string }).rowId);
    if (!Number.isInteger(id) || !Number.isInteger(rowId)) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    const parsed = zRowPatch.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }

    try {
      updateRow(db, id, rowId, parsed.data);
      return getImportDetail(db, id);
    } catch (err) {
      if (handleImportError(err, reply)) return;
      throw err;
    }
  });

  app.post('/api/imports/:id/commit', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    const parsed = zCommitRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }

    try {
      return commitImport(db, id, { allowUncategorized: parsed.data.allowUncategorized ?? false });
    } catch (err) {
      if (handleImportError(err, reply)) return;
      throw err;
    }
  });

  app.post('/api/imports/:id/discard', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    try {
      discardImport(db, id);
      return { status: 'discarded' as const };
    } catch (err) {
      if (handleImportError(err, reply)) return;
      throw err;
    }
  });

  // Decision 002-E: not in the spec's enumerated API-surface list, but the
  // "Extend history" assist it describes needs an endpoint; this is the
  // natural REST shape for it alongside commit/discard.
  app.post('/api/imports/:id/extend-history', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    try {
      return extendHistory(db, id);
    } catch (err) {
      if (handleImportError(err, reply)) return;
      throw err;
    }
  });
}
