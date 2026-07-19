import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { DEV_DATABASE_PATH, REAL_DATABASE_PATH, databasePathFor, resolveMode } from '../src/config';
import { createDb } from '../src/db/client';
import {
  assertDatabaseMatchesMode,
  assertNowOverrideAllowed,
  openDatabaseForMode,
} from '../src/db/mode-guard';
import { runMigrations } from '../src/db/migrate';
import { assertSeedableDatabase, markSyntheticSeed } from '../src/db/marker';
import { createTestDb } from './helpers';

/**
 * Proposal 005 — the real/dev database split. Everything here runs against
 * tempfile SQLite; nothing may touch `data/*.db` (CLAUDE.md validation §2).
 */

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * The repo's own tsx, not `npx`: `npm run check` is the session exit gate, and
 * `npx` may hit the network to resolve a package on a cold cache.
 */
const TSX = resolve(SERVER_ROOT, '../../node_modules/.bin/tsx');

/**
 * Toggle for the one test that needs migrations to fail. Everything else gets
 * the real implementation, so the mock is transparent by default.
 */
let failMigrations = false;
vi.mock('../src/db/migrate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db/migrate')>();
  return {
    ...actual,
    runMigrations: (db: Parameters<typeof actual.runMigrations>[0]) => {
      if (failMigrations) throw new Error('migration exploded');
      return actual.runMigrations(db);
    },
  };
});

describe('DB mode split (proposal 005)', () => {
  const dirs: string[] = [];
  const savedMode = process.env.FINANCE_MODE;

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'db-mode-'));
    dirs.push(dir);
    return dir;
  }

  /** A DB the dev server / a real import would leave behind: no marker. */
  function unmarkedDb(dir: string): string {
    const path = join(dir, 'app.db');
    const db = createDb(path);
    runMigrations(db);
    db.$client.close();
    return path;
  }

  /**
   * Content hash of the database file, for "the guard did not touch this"
   * assertions. mtime is too weak — same-millisecond writes are invisible at
   * its granularity.
   *
   * The main file only, deliberately: merely opening a WAL database (which the
   * marker check does, readonly) creates empty `-wal`/`-shm` siblings. That
   * writes no data and does not survive as state, so hashing the siblings would
   * assert against SQLite's bookkeeping rather than against the guard.
   */
  function fingerprint(path: string): string {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  }

  function markedDb(dir: string): string {
    const path = join(dir, 'dev.db');
    const db = createDb(path);
    runMigrations(db);
    markSyntheticSeed(db);
    db.$client.close();
    return path;
  }

  /** Run `body` with `runMigrations` throwing, restoring it even on failure. */
  function withFailingMigrations(body: () => void): void {
    failMigrations = true;
    try {
      body();
    } finally {
      failMigrations = false;
    }
  }

  beforeEach(() => {
    delete process.env.FINANCE_MODE;
  });

  afterEach(() => {
    if (savedMode === undefined) delete process.env.FINANCE_MODE;
    else process.env.FINANCE_MODE = savedMode;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  describe('criterion 1: FINANCE_MODE unset or invalid fails loudly, creating no file', () => {
    it('refuses when unset, naming the variable and both valid values', () => {
      expect(() => resolveMode()).toThrow(/FINANCE_MODE must be "real" or "dev".*\(unset\)/s);
    });

    it.each(['REAL', 'prod', '', 'dev '])('refuses the invalid value %o', (raw) => {
      process.env.FINANCE_MODE = raw;
      expect(() => resolveMode()).toThrow(/FINANCE_MODE must be "real" or "dev"/);
    });

    it('fails server startup without creating any database file', () => {
      // The whole entrypoint, in a throwaway CWD: the ordering claim (mode is
      // resolved before anything opens a path) is only worth anything if
      // index.ts actually honours it, which no unit test of resolveMode proves.
      const cwd = tempDir();
      const env: NodeJS.ProcessEnv = { ...process.env, PORT: '0' };
      delete env.FINANCE_MODE;

      let stderr = '';
      let exitCode = 0;
      try {
        execFileSync(TSX, [join(SERVER_ROOT, 'src/index.ts')], {
          cwd,
          env,
          stdio: 'pipe',
          timeout: 60_000,
        });
      } catch (err) {
        const e = err as { status?: number; stderr?: Buffer };
        exitCode = e.status ?? -1;
        stderr = e.stderr?.toString() ?? '';
      }

      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/FINANCE_MODE must be "real" or "dev"/);
      expect(readdirSync(cwd)).toEqual([]);
    }, 90_000);

    it('accepts the two valid values and maps them to distinct paths', () => {
      process.env.FINANCE_MODE = 'real';
      expect(resolveMode()).toBe('real');
      process.env.FINANCE_MODE = 'dev';
      expect(resolveMode()).toBe('dev');

      expect(databasePathFor('real')).toBe(REAL_DATABASE_PATH);
      expect(databasePathFor('dev')).toBe(DEV_DATABASE_PATH);
      expect(REAL_DATABASE_PATH).not.toBe(DEV_DATABASE_PATH);
    });
  });

  describe('criterion 2: real mode refuses a database bearing the synthetic marker', () => {
    it('throws with remediation and leaves the file untouched', () => {
      const path = markedDb(tempDir());
      const before = fingerprint(path);

      expect(() => assertDatabaseMatchesMode('real', path)).toThrow(
        /_synthetic_seed marker.*Delete .*to start a real database/s,
      );
      expect(fingerprint(path)).toBe(before);
    });

    it('accepts an unmarked database — that is what a real one looks like', () => {
      const path = unmarkedDb(tempDir());
      expect(() => assertDatabaseMatchesMode('real', path)).not.toThrow();
    });

    // The guard is only worth anything if the function that opens the database
    // actually calls it: asserting `assertDatabaseMatchesMode` alone stays green
    // even if `openDatabaseForMode` stops calling it, which is the whole bug.
    it('refuses through openDatabaseForMode, leaving the seed untouched', () => {
      const path = markedDb(tempDir());
      const before = fingerprint(path);

      expect(() => openDatabaseForMode('real', path)).toThrow(/_synthetic_seed marker/);
      expect(fingerprint(path)).toBe(before);
    });
  });

  describe('criterion 3: dev mode refuses an existing database lacking the marker', () => {
    it('throws with remediation and leaves the file untouched', () => {
      const path = unmarkedDb(tempDir());
      const before = fingerprint(path);

      expect(() => assertDatabaseMatchesMode('dev', path)).toThrow(
        /no _synthetic_seed marker.*may hold real data/s,
      );
      expect(fingerprint(path)).toBe(before);
    });

    it('refuses through openDatabaseForMode, leaving the file untouched', () => {
      const path = unmarkedDb(tempDir());
      const before = fingerprint(path);

      expect(() => openDatabaseForMode('dev', path)).toThrow(/no _synthetic_seed marker/);
      expect(fingerprint(path)).toBe(before);
    });

    it('accepts a marked database', () => {
      const path = markedDb(tempDir());
      expect(() => assertDatabaseMatchesMode('dev', path)).not.toThrow();
    });

    it('accepts a path with no file yet, in either mode', () => {
      const dir = tempDir();
      expect(() => assertDatabaseMatchesMode('dev', join(dir, 'nope.db'))).not.toThrow();
      expect(() => assertDatabaseMatchesMode('real', join(dir, 'nope.db'))).not.toThrow();
    });
  });

  describe('criterion 4: dev mode creates, migrates and marks a fresh database', () => {
    it('marks it, so a subsequent seed:test guard passes', () => {
      const path = join(tempDir(), 'dev.db');

      const db = openDatabaseForMode('dev', path);
      // Migrated: a domain table the schema defines exists.
      expect(db.$client.prepare(`SELECT count(*) AS n FROM accounts`).get()).toEqual({ n: 0 });
      db.$client.close();

      expect(() => assertSeedableDatabase(path)).not.toThrow();
    });

    it('does not mark a fresh database in real mode', () => {
      const path = join(tempDir(), 'app.db');

      const db = openDatabaseForMode('real', path);
      db.$client.close();

      // No marker => seed:test would refuse it, which is the whole point.
      expect(() => assertSeedableDatabase(path)).toThrow(/refusing to overwrite/);
    });

    it('removes a fresh database whose migration failed, WAL siblings included', () => {
      const dir = tempDir();
      const path = join(dir, 'dev.db');

      withFailingMigrations(() => {
        expect(() => openDatabaseForMode('dev', path)).toThrow(/migration exploded/);
      });

      // Left behind, it would be unmarked — so the next dev start would refuse
      // it as "may hold real data", about a file this process just created.
      expect(readdirSync(dir)).toEqual([]);
    });

    // The `fresh` guard on the discard path is the only thing between a failed
    // migration and `rmSync` of the owner's real database. Nothing else in the
    // suite would notice it going away.
    it.each([
      ['a marked dev database', 'dev' as const, markedDb],
      ['an unmarked real database', 'real' as const, unmarkedDb],
    ])('never deletes a pre-existing database when migration fails: %s', (_label, mode, make) => {
      const path = make(tempDir());
      const before = fingerprint(path);

      withFailingMigrations(() => {
        expect(() => openDatabaseForMode(mode, path)).toThrow(/migration exploded/);
      });

      expect(existsSync(path)).toBe(true);
      expect(fingerprint(path)).toBe(before);
    });

    it('does not re-mark an already-marked database on reopen', () => {
      const path = markedDb(tempDir());

      const db = openDatabaseForMode('dev', path);
      const { n } = db.$client.prepare(`SELECT count(*) AS n FROM _synthetic_seed`).get() as {
        n: number;
      };
      db.$client.close();

      expect(n).toBe(1);
    });
  });

  describe('criterion 5: real mode refuses to start with FINANCE_NOW set', () => {
    it('throws, naming the write-lock consequence', () => {
      expect(() => assertNowOverrideAllowed('real', '2026-06-15')).toThrow(
        /FINANCE_NOW is set.*past-month write lock/s,
      );
    });

    it('allows it in dev mode, and allows real mode without it', () => {
      expect(() => assertNowOverrideAllowed('dev', '2026-06-15')).not.toThrow();
      expect(() => assertNowOverrideAllowed('real', null)).not.toThrow();
    });
  });

  describe('criterion 6: /health reports the running mode', () => {
    it('reports the mode buildApp was given', async () => {
      const app = buildApp(createTestDb(), { mode: 'real' });
      await app.ready();
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.json()).toEqual({ status: 'ok', mode: 'real' });
      await app.close();
    });

    it('defaults to dev when no mode is given (tests are synthetic)', async () => {
      const app = buildApp(createTestDb());
      await app.ready();
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.json()).toEqual({ status: 'ok', mode: 'dev' });
      await app.close();
    });
  });

  describe('criterion 8: seed:test writes the dev path regardless of FINANCE_MODE', () => {
    // Runs the real script in a throwaway CWD (the paths are CWD-relative), with
    // FINANCE_MODE deliberately set to `real`. The seed is synthetic by
    // construction, so it never reads the variable — asserted here end-to-end
    // rather than by inspecting imports.
    it('seeds data/dev.db and never data/app.db, even under FINANCE_MODE=real', () => {
      const cwd = tempDir();

      execFileSync(TSX, [join(SERVER_ROOT, 'src/scripts/seed-test.ts')], {
        cwd,
        env: { ...process.env, FINANCE_MODE: 'real' },
        stdio: 'pipe',
      });

      expect(existsSync(join(cwd, DEV_DATABASE_PATH))).toBe(true);
      expect(existsSync(join(cwd, REAL_DATABASE_PATH))).toBe(false);
    }, 120_000);
  });
});
