import { defineConfig } from 'drizzle-kit';
import { DATABASE_PATH } from './src/config';

/**
 * Drizzle Kit configuration. Migrations are generated into `./drizzle` and are
 * the only sanctioned way to change the schema (non-negotiable #6). The MVP
 * schema (spec 001) lives in `./src/db/schema.ts`; `db:generate` diffs it into
 * numbered migrations there.
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
