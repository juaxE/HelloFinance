import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from './db/client';
import { registerAccountRoutes } from './routes/accounts';
import { registerCategoryRoutes } from './routes/categories';

/**
 * Build the Fastify application over an already-migrated database. Feature
 * routes are registered here per the approved specs under `specs/`; spec 001
 * adds the accounts and categories reference resources.
 *
 * There is deliberately no auth layer: the server binds to loopback only and
 * localhost auth would be theater (CLAUDE.md non-negotiable #2).
 */
export function buildApp(db: Db): FastifyInstance {
  const app = Fastify({
    logger: true,
  });

  app.get('/health', async () => {
    return { status: 'ok' as const };
  });

  registerAccountRoutes(app, db);
  registerCategoryRoutes(app, db);

  return app;
}
