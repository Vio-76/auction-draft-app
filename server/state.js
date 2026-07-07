/**
 * The in-memory state object is the runtime source of truth. Every mutation updates it
 * synchronously and then write-throughs to SQLite via persist(). Because this is all
 * synchronous (no await), each mutation is an atomic read-modify-write on the event
 * loop — which is what makes concurrent bids safe without any locking.
 *
 * State is tiny (a handful of captains, a few dozen players), so persist() simply
 * rewrites everything in one transaction with explicit ids. Cheap, and it removes a
 * whole class of "did I forget to save this field" bugs.
 */

const { db, migrate, transaction } = require('./db');
const { DEFAULT_SETTINGS } = require('./config');

const state = {
  settings: { ...DEFAULT_SETTINGS },
  captains: [],   // { id, name, code, price, seat } — kept sorted by seat
  players: [],    // { id, name, role, status, captainId, price }
  auction: { currentPlayerId: null, highestBid: 0, byCaptainId: null },
  // Ephemeral clocks (were Apps Script script properties) — never persisted.
  // pausedRemaining: snapshot of the countdown when the admin pauses (display only).
  // lastOpening: snapshot of the most recent opening bid (for the timed announcement banner).
  clocks: { openingDeadline: 0, lastBidTime: 0, lastSold: null, lastOpening: null, previousSellMode: null, pausedRemaining: null },
};

// ----- load -----

function load() {
  migrate();

  const settingsRows = db.prepare('SELECT key, value FROM settings').all();
  if (settingsRows.length === 0) {
    // Fresh database: seed defaults.
    persistSettings();
  } else {
    for (const row of settingsRows) {
      try { state.settings[row.key] = JSON.parse(row.value); } catch { /* skip bad row */ }
    }
    // Backfill any settings keys added since this DB was created.
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (!(key in state.settings)) state.settings[key] = DEFAULT_SETTINGS[key];
    }
  }

  state.captains = db.prepare('SELECT id, name, code, price, role, seat, discord FROM captains ORDER BY seat, id').all();

  state.players = db.prepare('SELECT id, name, role, status, captain_id AS captainId, price, discord, sold_seq AS soldSeq, image FROM players ORDER BY id').all();

  const a = db.prepare('SELECT current_player_id AS currentPlayerId, highest_bid AS highestBid, by_captain_id AS byCaptainId FROM auction WHERE id = 1').get();
  state.auction = a || { currentPlayerId: null, highestBid: 0, byCaptainId: null };

  return state;
}

// ----- persist (write-through) -----

function persistSettings() {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  transaction(() => {
    for (const [key, value] of Object.entries(state.settings)) {
      stmt.run(key, JSON.stringify(value));
    }
  });
}

function persistCaptains() {
  transaction(() => {
    db.prepare('DELETE FROM captains').run();
    const stmt = db.prepare('INSERT INTO captains (id, name, code, price, role, seat, discord) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const c of state.captains) stmt.run(c.id, c.name, c.code, c.price, c.role || '', c.seat, c.discord || '');
  });
}

function persistPlayers() {
  transaction(() => {
    db.prepare('DELETE FROM players').run();
    const stmt = db.prepare('INSERT INTO players (id, name, role, status, captain_id, price, discord, sold_seq, image) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const p of state.players) stmt.run(p.id, p.name, p.role, p.status, p.captainId ?? null, p.price, p.discord || '', p.soldSeq || 0, p.image || '');
  });
}

function persistAuction() {
  db.prepare('UPDATE auction SET current_player_id = ?, highest_bid = ?, by_captain_id = ? WHERE id = 1')
    .run(state.auction.currentPlayerId ?? null, state.auction.highestBid, state.auction.byCaptainId ?? null);
}

/** Persist everything (used after multi-table mutations like reset/import). */
function persistAll() {
  persistSettings();
  persistCaptains();
  persistPlayers();
  persistAuction();
}

// ----- id allocation (in-memory; ids preserved across persist) -----

function nextId(rows) {
  let max = 0;
  for (const r of rows) if (r.id > max) max = r.id;
  return max + 1;
}
const nextCaptainId = () => nextId(state.captains);
const nextPlayerId = () => nextId(state.players);

/** Next acquisition sequence: one past the highest soldSeq currently on any player.
 *  Monotonic, so a freshly-sold player always sorts after every earlier purchase. */
const nextSoldSeq = () => {
  let max = 0;
  for (const p of state.players) if ((p.soldSeq || 0) > max) max = p.soldSeq;
  return max + 1;
};

// ----- selectors -----

const captainById = (id) => state.captains.find((c) => c.id === id) || null;
const captainByName = (name) => state.captains.find((c) => c.name === String(name).trim()) || null;
const playerById = (id) => state.players.find((p) => p.id === id) || null;
const playerByName = (name) => state.players.find((p) => p.name === String(name).trim()) || null;

const captainsBySeat = () => [...state.captains].sort((a, b) => a.seat - b.seat || a.id - b.id);
const openPlayers = () => state.players.filter((p) => p.status === 'open');
const draftedPlayers = (captainId) => state.players
  .filter((p) => p.captainId === captainId && p.status === 'sold')
  .sort((a, b) => (a.soldSeq || 0) - (b.soldSeq || 0) || a.id - b.id);   // acquisition order, so new buys append

module.exports = {
  state,
  load,
  persistSettings,
  persistCaptains,
  persistPlayers,
  persistAuction,
  persistAll,
  nextCaptainId,
  nextPlayerId,
  nextSoldSeq,
  captainById,
  captainByName,
  playerById,
  playerByName,
  captainsBySeat,
  openPlayers,
  draftedPlayers,
};
