/**
 * A D1-shaped façade over node:sqlite, so the account tests run the real SQL
 * rather than a hand-written stand-in for it.
 *
 * `node:sqlite` landed in Node 22. CI also runs Node 20, where these tests
 * skip rather than fail — the coverage is real on 22 and honestly absent on
 * 20, which is better than a fake that passes everywhere.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

/** True when this Node can run the database-backed tests. */
export const sqliteAvailable = DatabaseSync !== null;

const MIGRATION = fileURLToPath(new URL('../../migrations/0001_accounts.sql', import.meta.url));

/** Wrap a node:sqlite handle in the subset of the D1 API we use. */
function wrap(database) {
  return {
    prepare(sql) {
      let bound = [];
      const statement = {
        bind(...args) {
          bound = args.map((value) => (value === undefined ? null : value));
          return statement;
        },
        first() {
          return database.prepare(sql).get(...bound) ?? null;
        },
        all() {
          return { results: database.prepare(sql).all(...bound) };
        },
        run() {
          const info = database.prepare(sql).run(...bound);
          return { success: true, meta: { changes: info.changes } };
        },
      };
      return statement;
    },
    exec(sql) {
      database.exec(sql);
    },
    close() {
      database.close();
    },
  };
}

/** A fresh in-memory database with the migration applied. */
export function freshDb() {
  if (!sqliteAvailable) throw new Error('node:sqlite is unavailable');

  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON;');
  database.exec(readFileSync(MIGRATION, 'utf8'));
  return wrap(database);
}
