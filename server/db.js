/**
 * SQLite layer (Node's built-in, synchronous `node:sqlite`). Synchronous is deliberate:
 * it lets every state mutation be a single uninterruptible read-modify-write on the
 * event loop, which is what replaces the old Apps Script LockService (see the plan's
 * "Concurrency model"). Do not introduce an async DB driver here.
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'auction.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL              -- JSON-encoded scalar
);

CREATE TABLE IF NOT EXISTS captains (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL,
  code  TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL DEFAULT 0,
  role  TEXT NOT NULL DEFAULT '',
  seat  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS players (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'sold'
  captain_id INTEGER,                        -- NULL while open
  price      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS auction (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  current_player_id INTEGER,
  highest_bid       INTEGER NOT NULL DEFAULT 0,
  by_captain_id     INTEGER
);
`;

/** Adds a column to an existing table if it isn't there yet (for DBs created before it). */
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function migrate() {
  db.exec(SCHEMA);
  ensureColumn('captains', 'role', "TEXT NOT NULL DEFAULT ''"); // added after first release
  // Ensure the single auction row exists.
  db.prepare('INSERT OR IGNORE INTO auction (id, current_player_id, highest_bid, by_captain_id) VALUES (1, NULL, 0, NULL)').run();
}

/** Runs `fn` inside a transaction, rolling back on any throw. */
function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, migrate, transaction, DB_PATH };
