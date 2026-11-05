import fs from 'node:fs';
import path from 'node:path';
import knexLib from 'knex';
import { config } from './config.js';

if (config.db.client === 'better-sqlite3') {
  fs.mkdirSync(path.dirname(config.db.connection.filename), { recursive: true });
}

export const db = knexLib(config.db);

export const now = () => Date.now();

/** Parse a JSON text column safely. */
export function j(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

/** Serialize for a JSON text column. */
export const s = (value) => (value === undefined ? undefined : JSON.stringify(value ?? null));

/** Insert and return the new id on SQLite, MySQL and Postgres alike. */
export async function insert(table, row, trx = db) {
  const res = await trx(table).insert(row, ['id']);
  const first = res[0];
  return typeof first === 'object' ? first.id : first;
}

export const bool = (v) => v === true || v === 1 || v === '1';

export const period = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 7);
