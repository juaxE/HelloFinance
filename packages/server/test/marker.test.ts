import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { assertSeedableDatabase, markSyntheticSeed } from '../src/db/marker';

/**
 * Audit item B2: `seed:test` deletes whatever sits at DATABASE_PATH, which is
 * the same path the real DB lives at. The guard makes that structurally safe:
 * only a DB carrying the `_synthetic_seed` marker (written by the seed script
 * itself) may be overwritten.
 */
describe('seed guard (audit B2)', () => {
  const dirs: string[] = [];

  function tempDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'marker-'));
    dirs.push(dir);
    return join(dir, 'app.db');
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('allows a path with no database file', () => {
    const path = tempDbPath();
    expect(existsSync(path)).toBe(false);
    expect(() => assertSeedableDatabase(path)).not.toThrow();
  });

  it('refuses an existing database without the synthetic marker (the real-DB shape)', () => {
    const path = tempDbPath();
    const db = createDb(path); // an unmarked DB, i.e. the real one's shape
    runMigrations(db);
    db.$client.close();

    expect(() => assertSeedableDatabase(path)).toThrow(/refusing to overwrite/);
  });

  it('allows a database the seed script itself marked, repeatedly', () => {
    const path = tempDbPath();
    const db = createDb(path);
    runMigrations(db);
    markSyntheticSeed(db);
    db.$client.close();

    expect(() => assertSeedableDatabase(path)).not.toThrow();
    // Re-marking (the reseed cycle) must also be fine.
    const again = createDb(path);
    markSyntheticSeed(again);
    again.$client.close();
    expect(() => assertSeedableDatabase(path)).not.toThrow();
  });

  it('does not modify the refused database', () => {
    const path = tempDbPath();
    const db = createDb(path);
    runMigrations(db);
    const before = db.$client.prepare('SELECT count(*) AS n FROM categories').get() as {
      n: number;
    };
    db.$client.close();

    expect(() => assertSeedableDatabase(path)).toThrow();

    const after = createDb(path);
    const count = after.$client.prepare('SELECT count(*) AS n FROM categories').get() as {
      n: number;
    };
    expect(count.n).toBe(before.n);
    after.$client.close();
  });
});
