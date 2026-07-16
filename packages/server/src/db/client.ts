import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { DATABASE_PATH } from '../config';

// Drizzle's `drizzle()` return intersects the base type with `{ $client }` (the
// raw better-sqlite3 handle); preserve it so pragma/introspection stays typed.
export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/**
 * Open a Drizzle client over a better-sqlite3 connection.
 *
 * Pass `':memory:'` (or a tempfile path) in tests — integration tests must
 * never touch `data/*.db` (CLAUDE.md validation §2). WAL mode + foreign keys
 * are enabled for every connection.
 */
export function createDb(path: string): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  return drizzle(sqlite, { schema });
}

let singleton: Db | undefined;

/**
 * Lazily-created process-wide client against `DATABASE_PATH`. Lazy so that
 * merely importing this module (e.g. from tests or tooling) does not create a
 * database file on disk.
 */
export function getDb(): Db {
  if (!singleton) {
    if (!existsSync(dirname(DATABASE_PATH))) {
      mkdirSync(dirname(DATABASE_PATH), { recursive: true });
    }
    singleton = createDb(DATABASE_PATH);
  }
  return singleton;
}
