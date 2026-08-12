import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(here, '../schema.sql');

export const DEFAULT_DB_PATH = resolve(here, '../../../data/vibegram.db');

export function openDb(path: string = process.env.VIBEGRAM_DB ?? DEFAULT_DB_PATH): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  // WAL: the web view reads the feed while agents keep writing events.
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  migrate(db);
  return db;
}

/**
 * `CREATE TABLE IF NOT EXISTS` never touches a table that already exists, so a
 * new column has to be added by hand or the deployed hub breaks on first query.
 * Each step checks for itself and is safe to run repeatedly.
 */
function migrate(db: DatabaseSync): void {
  const columns = (table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

  if (!columns('agents').includes('hooks_seen_at')) {
    db.exec('ALTER TABLE agents ADD COLUMN hooks_seen_at TEXT');
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
