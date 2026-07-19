import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
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

/**
 * `now` is injectable so budget tests can pin the current month: the synthetic
 * fixtures run 2025-07..2026-06, and rules keyed to "the current month"
 * (auto-materialization, the 003-N non-ended set, the review-Q1 hint) would
 * otherwise depend on the wall clock and rot.
 */
export type AppOptions = { now?: () => Date };

/**
 * Build the Fastify application over an already-migrated database. Feature
 * routes are registered here per the approved specs under `specs/`; spec 001
 * adds the accounts and categories reference resources, spec 002 adds CSV
 * import/review, labeling rules, and transactions. Spec 003 adds recurring
 * templates and budget months. Spec 004 adds the read-only dashboard
 * aggregates and asset snapshots.
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

  app.get('/health', async () => {
    return { status: 'ok' as const };
  });

  registerAccountRoutes(app, db);
  registerAssetRoutes(app, db);
  registerCategoryRoutes(app, db);
  registerImportRoutes(app, db);
  registerLabelingRuleRoutes(app, db);
  registerTransactionRoutes(app, db);
  registerRecurringTemplateRoutes(app, db, currentMonth);
  registerBudgetRoutes(app, db, currentMonth);
  registerDashboardRoutes(app, db, currentMonth);

  return app;
}
