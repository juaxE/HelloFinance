import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Build the Fastify application. No routes beyond `/health` exist yet — feature
 * routes are added per the approved specs under `specs/`.
 *
 * There is deliberately no auth layer: the server binds to loopback only and
 * localhost auth would be theater (CLAUDE.md non-negotiable #2).
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: true,
  });

  app.get('/health', async () => {
    return { status: 'ok' as const };
  });

  return app;
}
