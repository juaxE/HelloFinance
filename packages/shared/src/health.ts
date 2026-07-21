import { z } from 'zod';

/**
 * Which database the running server is attached to (proposal 005).
 *
 * `real` is the owner's own finances (`data/app.db`, `npm start`); `dev` is the
 * synthetic seed (`data/dev.db`, `npm run dev`, `seed:test`, Playwright). The
 * UI reads this off `/health` to show the synthetic-data banner — the only
 * mitigation for a real CSV being imported into a dev instance, which nothing
 * can detect from the file's contents.
 */
export const zFinanceMode = z.enum(['real', 'dev']);
export type FinanceMode = z.infer<typeof zFinanceMode>;

export const zHealth = z.object({
  status: z.literal('ok'),
  mode: zFinanceMode,
});
export type Health = z.infer<typeof zHealth>;
