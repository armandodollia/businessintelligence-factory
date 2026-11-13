import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations.js';
import { createRepos, type Repos } from './repos.js';

export type Store = Repos & {
  readonly db: DatabaseSync;
  /** Number of applied migrations (`PRAGMA user_version`). */
  schemaVersion(): number;
  /** Runs `fn` inside a transaction (BEGIN IMMEDIATE / COMMIT, ROLLBACK on throw). */
  transaction<R>(fn: () => R): R;
  close(): void;
};

function userVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return Number(row?.user_version ?? 0);
}

/** Applies pending migrations, each in its own transaction. Safe to call repeatedly. */
export function migrate(db: DatabaseSync): void {
  const current = userVersion(db);
  if (current > MIGRATIONS.length) {
    throw new Error(
      `database schema version ${current} is newer than this build (${MIGRATIONS.length})`,
    );
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

/** Opens (creating if needed) the SQLite store at `dbPath` and runs migrations. */
export function openStore(dbPath: string): Store {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
  } catch (e) {
    db.close();
    throw e;
  }
  let depth = 0;
  return {
    ...createRepos(db),
    db,
    schemaVersion: () => userVersion(db),
    transaction<R>(fn: () => R): R {
      // Nested calls join the outer transaction.
      if (depth > 0) return fn();
      db.exec('BEGIN IMMEDIATE');
      depth++;
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      } finally {
        depth--;
      }
    },
    close: () => {
      if (db.isOpen) db.close();
    },
  };
}
