import { DatabaseSync } from "node:sqlite";

import { SCHEMA_STATEMENTS } from "./schema.ts";

export type Database = DatabaseSync;

const depthByDatabase = new WeakMap<Database, number>();

/** SQLite writes one WAL frame per commit; `synchronous=FULL` is what makes a
 * command durable before its native execution starts. */
export function openDatabase(path: string): Database {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: Database): void {
  for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
}

/** Runs `fn` atomically. Nested calls use savepoints so a command handler can
 * compose smaller transactional helpers. */
export function inTransaction<T>(db: Database, fn: () => T): T {
  const depth = depthByDatabase.get(db) ?? 0;
  depthByDatabase.set(db, depth + 1);
  try {
    return depth === 0 ? runOuter(db, fn) : runSavepoint(db, depth, fn);
  } finally {
    depthByDatabase.set(db, depth);
  }
}

function runOuter<T>(db: Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function runSavepoint<T>(db: Database, depth: number, fn: () => T): T {
  const name = `sp_${depth}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const value = fn();
    db.exec(`RELEASE ${name}`);
    return value;
  } catch (error) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw error;
  }
}
