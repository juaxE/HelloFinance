import { defineConfig } from 'drizzle-kit';
import { DEV_DATABASE_PATH } from './src/config';

/**
 * Drizzle Kit configuration. Migrations are generated into `./drizzle` and are
 * the only sanctioned way to change the schema (non-negotiable #6). The MVP
 * schema (spec 001) lives in `./src/db/schema.ts`; `db:generate` diffs it into
 * numbered migrations there.
 *
 * Pinned to the dev database on purpose: drizzle-kit is developer tooling and
 * must never open the real one. The real database receives migrations at server
 * startup (`index.ts` → `openDatabaseForMode` → `runMigrations`), never here.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: DEV_DATABASE_PATH,
  },
  strict: true,
  verbose: true,
});
