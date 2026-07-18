import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from './db/client';
import { registerAccountRoutes } from './routes/accounts';
import { registerCategoryRoutes } from './routes/categories';
import { registerImportRoutes } from './routes/imports';
import { registerLabelingRuleRoutes } from './routes/labeling-rules';
import { registerTransactionRoutes } from './routes/transactions';

/**
 * Build the Fastify application over an already-migrated database. Feature
 * routes are registered here per the approved specs under `specs/`; spec 001
 * adds the accounts and categories reference resources, spec 002 adds CSV
 * import/review, labeling rules, and transactions.
 *
 * There is deliberately no auth layer: the server binds to loopback only and
 * localhost auth would be theater (CLAUDE.md non-negotiable #2).
 */
export function buildApp(db: Db): FastifyInstance {
  const app = Fastify({
    logger: true,
  });

  // CSV exports are small (a year of history is well under 1 MB); 20 MB caps
  // a pathological upload without ever being a real constraint.
  app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });

  app.get('/health', async () => {
    return { status: 'ok' as const };
  });

  registerAccountRoutes(app, db);
  registerCategoryRoutes(app, db);
  registerImportRoutes(app, db);
  registerLabelingRuleRoutes(app, db);
  registerTransactionRoutes(app, db);

  return app;
}
