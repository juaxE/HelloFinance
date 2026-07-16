import { defineConfig } from 'drizzle-kit';
import { DATABASE_PATH } from './src/config';

/**
 * Drizzle Kit configuration. Migrations are generated into `./drizzle` and are
 * the only sanctioned way to change the schema (non-negotiable #6). There are
 * no domain tables yet, so `db:generate` currently produces no migrations.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: DATABASE_PATH,
  },
  strict: true,
  verbose: true,
});
