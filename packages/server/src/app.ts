import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import type { FinanceMode, Health } from '@finance/shared';
import type { Db } from './db/client';
import { monthOf } from './budgets/months';
import { registerAccountRoutes } from './routes/accounts';
import { registerAssetRoutes } from './routes/assets';
import { registerBudgetRoutes } from './routes/budgets';
import { registerCategoryRoutes } from './routes/categories';
import { registerDashboardRoutes } from './routes/dashboard';
import { registerImportRoutes } from './routes/imports';
import { registerLabelingRuleRoutes } from './routes/labeling-rules';
import { registerRecurringTemplateRoutes } from './routes/recurring-templates';
import { registerTransactionRoutes } from './routes/transactions';
import { registerTriageRoutes } from './routes/triage';

/**
 * `now` is injectable so budget tests can pin the current month: the synthetic
 * fixtures run 2025-07..2026-06, and rules keyed to "the current month"
 * (auto-materialization, the 003-N non-ended set, the review-Q1 hint) would
 * otherwise depend on the wall clock and rot.
 *
 * `mode` defaults to `dev` because a test database is definitionally synthetic;
 * requiring it would ripple through every test file to say something none of
 * them have an opinion about. Only `index.ts` passes it explicitly.
 */
export type AppOptions = { now?: () => Date; mode?: FinanceMode };

/**
 * Build the Fastify application over an already-migrated database. Registers
 * the accounts and categories reference resources; CSV import/review, labeling
 * rules and transactions; recurring templates and budget months; and the
 * read-only dashboard aggregates and asset snapshots.
 *
 * There is deliberately no auth layer: the server binds to loopback only and
 * localhost auth would be theater (CLAUDE.md non-negotiable #2).
 */
export function buildApp(db: Db, options: AppOptions = {}): FastifyInstance {
  const currentMonth = (): string => monthOf(options.now ? options.now() : new Date());

  const app = Fastify({
    logger: true,
  });

  // CSV exports are small (a year of history is well under 1 MB); 20 MB caps
  // a pathological upload without ever being a real constraint.
  app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });

  // The UI reads `mode` here to decide whether to show the synthetic-data
  // banner (proposal 005).
  app.get('/health', async (): Promise<Health> => {
    return { status: 'ok', mode: options.mode ?? 'dev' };
  });

  registerAccountRoutes(app, db);
  registerAssetRoutes(app, db);
  registerCategoryRoutes(app, db);
  registerImportRoutes(app, db);
  registerLabelingRuleRoutes(app, db);
  registerTransactionRoutes(app, db);
  registerTriageRoutes(app, db);
  registerRecurringTemplateRoutes(app, db, currentMonth);
  registerBudgetRoutes(app, db, currentMonth);
  registerDashboardRoutes(app, db, currentMonth);

  return app;
}
