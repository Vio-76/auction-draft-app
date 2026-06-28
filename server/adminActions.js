/**
 * Admin mutations. Each returns { ok, error? } and, on success, persists once and notifies
 * (commit()). They reuse the same logic the captain flow uses (turn/sell/team), so the
 * auction behaves identically whether a step is driven by a captain or the admin.
 *
 * Covers the full admin feature set: auction control (start/pause/empty-teams/advance/skip/sold/
 * status), settings, "whose turn is it", captain CRUD, player CRUD + bulk import, and
 * manual roster editing (move a player to/from a team, edit a price).
 */

const {
  state, persistAll, nextCaptainId, nextPlayerId,
  captainById, playerById, captainsBySeat,
} = require('./state');
const { STATUS, SELL_MODE, TURN_ORDER, TURN_DIR, PLAYER_STATUS, THEME_FONT_URLS } = require('./config');
const { markChanged } = require('./bus');
const team = require('./logic/team');
const turn = require('./logic/turn');
const sell = require('./logic/sell');

function commit() {
  // The paused-countdown snapshot is only meaningful while CLOSED; clear it on resume.
  if (state.settings.status !== STATUS.CLOSED) state.clocks.pausedRemaining = null;
  persistAll();
  markChanged();
}
function ok() { commit(); return { ok: true }; }
function err(msg) { return { ok: false, error: msg }; }

// Keep seats contiguous (0..n-1) in current order, and the marker within range.
function normalizeSeats() {
  const ordered = captainsBySeat();
  ordered.forEach((c, i) => { c.seat = i; });
  if (state.settings.marker >= ordered.length) state.settings.marker = ordered.length ? ordered.length - 1 : -1;
}

// ----- auction control -----

function startAuction() {
  team.clearAuctionBlock();
  sell.clearLastBidTime();
  turn.clearOpeningDeadline();
  state.clocks.lastSold = null;
  state.settings.marker = -1;
  state.settings.turnDirection = TURN_DIR.DOWN;
  turn.advanceTurn();            // -> first eligible captain, OPENING (or FINISHED if none)
  return ok();
}

/** Skip Turn: move the marker to the next captain (snake double-turn aware), in any phase,
 *  without changing the status or clearing the in-flight bid. Resets the opening-bid countdown
 *  to the full timeout so the new turn-holder gets a fresh clock. */
function skipTurn() {
  turn.skipMarker();
  turn.setOpeningDeadline();
  return ok();
}

function openBidding() {
  state.settings.status = STATUS.BIDDING;
  sell.setLastBidTime();         // treat reopening as a fresh bid (restarts cooldown/window)
  return ok();
}

function closeBidding() {        // pause
  // Snapshot how much of the live countdown was left, so the admin can see it while paused.
  // (Logic is unchanged: the deadline is still cleared and restarts fresh on resume.)
  let pr = null;
  if (state.settings.status === STATUS.OPENING) {
    pr = { kind: 'opening', seconds: turn.openingSecondsRemaining() };
  } else if (state.settings.status === STATUS.BIDDING && state.settings.sellMode === SELL_MODE.AUTO) {
    pr = { kind: 'autosell', seconds: sell.autoSellSecondsRemaining() };
  }
  state.clocks.pausedRemaining = pr;
  state.settings.status = STATUS.CLOSED;
  sell.clearLastBidTime();
  turn.clearOpeningDeadline();
  return ok();
}

function openOpeningBid() {
  state.settings.status = STATUS.OPENING;
  turn.setOpeningDeadline();
  return ok();
}

function sold() {
  if (state.settings.status !== STATUS.BIDDING) return err("Nothing to sell — bidding isn't open.");
  if (!sell.soldButtonUsable()) return err('Wait for the post-bid cooldown before selling.');
  const r = sell.finalizeSaleAndAdvance();   // sells + advances turn
  if (!r.ok) return r;
  return ok();
}

function setStatus(status) {
  const allowed = [STATUS.OPENING, STATUS.BIDDING, STATUS.CLOSED, STATUS.FINISHED];
  if (!allowed.includes(status)) return err('Invalid status.');
  state.clocks.pausedRemaining = null;   // manual override isn't a timed pause
  state.settings.status = status;
  if (status === STATUS.OPENING) turn.setOpeningDeadline();
  if (status === STATUS.BIDDING) sell.setLastBidTime();
  return ok();
}

/**
 * Empty every team's roster: send all drafted (non-captain) players back to the open pool.
 * Roster-only on purpose — it does NOT touch the turn/marker/status, so it pairs with
 * startAuction(): use Start alone to (re)begin, or Empty teams + Start for a full reset.
 */
function emptyTeams() {
  for (const p of state.players) {
    if (p.status === PLAYER_STATUS.SOLD) { p.status = PLAYER_STATUS.OPEN; p.captainId = null; p.price = 0; }
  }
  return ok();
}

// ----- settings -----

const NUMERIC_SETTINGS = ['smallBlind', 'teamBudget', 'teamSlots', 'openingTimeout', 'autoWindow', 'soldCooldown'];

function updateSettings(patch) {
  if (!patch || typeof patch !== 'object') return err('No settings provided.');
  const wasAuto = state.settings.sellMode === SELL_MODE.AUTO;

  for (const [key, raw] of Object.entries(patch)) {
    if (NUMERIC_SETTINGS.includes(key)) {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return err(`Invalid value for ${key}.`);
      state.settings[key] = Math.floor(n);
    } else if (key === 'sellMode') {
      if (raw !== SELL_MODE.AUTO && raw !== SELL_MODE.MANUAL) return err('Invalid sell mode.');
      state.settings.sellMode = raw;
    } else if (key === 'turnOrder') {
      if (raw !== TURN_ORDER.WATERFALL && raw !== TURN_ORDER.SNAKE) return err('Invalid turn order.');
      state.settings.turnOrder = raw;
    } else if (key === 'turnDirection') {
      state.settings.turnDirection = (raw === 'UP' || raw === -1) ? TURN_DIR.UP : TURN_DIR.DOWN;
    } else if (key === 'theme') {
      state.settings.theme = THEME_FONT_URLS[raw] ? raw : 'draftroom';
    } else if (key === 'showBidOnBoard') {
      state.settings.showBidOnBoard = (raw === true || raw === 'true' || raw === 1 || raw === '1' || raw === 'on');
    }
    // unknown keys ignored
  }

  // If we just switched MANUAL->AUTO mid-bidding, restart the window from now.
  if (!wasAuto && state.settings.sellMode === SELL_MODE.AUTO) sell.reanchorAutoWindowOnSwitchToAuto();
  return ok();
}

// ----- captains CRUD -----

function addCaptain({ name, code, price, role, seat } = {}) {
  const nm = String(name || '').trim();
  if (!nm) return err('Captain name is required.');
  const maxSeat = state.captains.reduce((m, c) => Math.max(m, c.seat), -1);
  state.captains.push({
    id: nextCaptainId(),
    name: nm,
    code: String(code || '').trim(),
    price: Math.max(0, Math.floor(Number(price) || 0)),
    role: String(role || '').trim(),
    seat: Number.isFinite(Number(seat)) ? Number(seat) : maxSeat + 1,
  });
  normalizeSeats();
  return ok();
}

/** Move a captain one slot earlier/later in the turn order. Nudges its seat past the
 *  neighbour, then normalizeSeats() renumbers everyone contiguously. */
function moveCaptain(id, dir) {
  const c = captainById(Number(id));
  if (!c) return err('Unknown captain.');
  c.seat += (dir === 'up' ? -1.5 : 1.5);
  normalizeSeats();
  return ok();
}

function updateCaptain(id, patch = {}) {
  const c = captainById(Number(id));
  if (!c) return err('Unknown captain.');
  if ('name' in patch) { const nm = String(patch.name).trim(); if (!nm) return err('Name cannot be empty.'); c.name = nm; }
  if ('code' in patch) c.code = String(patch.code).trim();
  if ('price' in patch) c.price = Math.max(0, Math.floor(Number(patch.price) || 0));
  if ('role' in patch) c.role = String(patch.role).trim();
  if ('seat' in patch) c.seat = Number(patch.seat);
  normalizeSeats();
  return ok();
}

/** Parse pasted captains: one per line, "name <tab|comma|2+ spaces> code, price, role"
 *  (only name required; the rest optional, in that order). */
function parseCaptainList(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\t|,|\s{2,}/).map((s) => s.trim());
    const name = parts[0];
    if (name) out.push({ name, code: parts[1] || '', price: Number(parts[2]) || 0, role: parts[3] || '' });
  }
  return out;
}

/** Bulk import captains. 'replace' clears all captains first (their drafted players return
 *  to the pool); 'append' adds after the existing ones. Returns { ok, added }. */
function importCaptains(text, mode = 'replace') {
  const parsed = parseCaptainList(text);
  if (!parsed.length) return err('No captains found in the pasted text.');

  if (mode === 'replace') {
    for (const p of state.players) {
      if (p.captainId != null) { p.status = PLAYER_STATUS.OPEN; p.captainId = null; p.price = 0; }
    }
    state.captains = [];
    state.settings.marker = -1;
    team.clearAuctionBlock();
  }
  let id = nextCaptainId();
  let seat = state.captains.reduce((m, c) => Math.max(m, c.seat), -1) + 1;
  for (const c of parsed) {
    state.captains.push({
      id: id++, name: c.name, code: c.code,
      price: Math.max(0, Math.floor(c.price)), role: c.role, seat: seat++,
    });
  }
  normalizeSeats();
  commit();
  return { ok: true, added: parsed.length };
}

function deleteCaptain(id) {
  const cid = Number(id);
  if (!captainById(cid)) return err('Unknown captain.');
  // Return their drafted players to the pool.
  for (const p of state.players) {
    if (p.captainId === cid) { p.status = PLAYER_STATUS.OPEN; p.captainId = null; p.price = 0; }
  }
  state.captains = state.captains.filter((c) => c.id !== cid);
  if (state.auction.byCaptainId === cid) { state.auction.byCaptainId = null; }
  normalizeSeats();
  return ok();
}

// ----- players CRUD + import -----

function addPlayer({ name, role } = {}) {
  const nm = String(name || '').trim();
  if (!nm) return err('Player name is required.');
  state.players.push({
    id: nextPlayerId(), name: nm, role: String(role || '').trim(),
    status: PLAYER_STATUS.OPEN, captainId: null, price: 0,
  });
  return ok();
}

function updatePlayer(id, patch = {}) {
  const p = playerById(Number(id));
  if (!p) return err('Unknown player.');
  if ('name' in patch) { const nm = String(patch.name).trim(); if (!nm) return err('Name cannot be empty.'); p.name = nm; }
  if ('role' in patch) p.role = String(patch.role).trim();
  return ok();
}

function deletePlayer(id) {
  const pid = Number(id);
  if (!playerById(pid)) return err('Unknown player.');
  state.players = state.players.filter((p) => p.id !== pid);
  if (state.auction.currentPlayerId === pid) team.clearAuctionBlock();
  return ok();
}

/** Parse pasted text: one player per line, "name <tab|comma|2+ spaces> role" (role optional). */
function parsePlayerList(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\t|,|\s{2,}/).map((s) => s.trim()).filter(Boolean);
    const name = parts[0];
    const role = parts[1] || '';
    if (name) out.push({ name, role });
  }
  return out;
}

/** Bulk import. mode 'replace' clears the current OPEN pool first (drafted players kept);
 *  'append' adds to it. Returns { ok, added }. */
function importPlayers(text, mode = 'replace') {
  const parsed = parsePlayerList(text);
  if (!parsed.length) return err('No players found in the pasted text.');

  if (mode === 'replace') {
    state.players = state.players.filter((p) => p.status === PLAYER_STATUS.SOLD);
    if (state.auction.currentPlayerId && !playerById(state.auction.currentPlayerId)) team.clearAuctionBlock();
  }
  let id = nextPlayerId();
  for (const { name, role } of parsed) {
    state.players.push({ id: id++, name, role, status: PLAYER_STATUS.OPEN, captainId: null, price: 0 });
  }
  commit();
  return { ok: true, added: parsed.length };
}

function clearPool() {
  state.players = state.players.filter((p) => p.status === PLAYER_STATUS.SOLD);
  return ok();
}

// ----- manual roster editing -----

function assignPlayerToTeam(playerId, captainId, price) {
  const p = playerById(Number(playerId));
  if (!p) return err('Unknown player.');
  const c = captainById(Number(captainId));
  if (!c) return err('Unknown captain.');
  p.status = PLAYER_STATUS.SOLD;
  p.captainId = c.id;
  p.price = Math.max(0, Math.floor(Number(price) || 0));
  return ok();
}

function removePlayerFromTeam(playerId) {
  const p = playerById(Number(playerId));
  if (!p) return err('Unknown player.');
  p.status = PLAYER_STATUS.OPEN;
  p.captainId = null;
  p.price = 0;
  return ok();
}

function setPlayerPrice(playerId, price) {
  const p = playerById(Number(playerId));
  if (!p) return err('Unknown player.');
  p.price = Math.max(0, Math.floor(Number(price) || 0));
  return ok();
}

module.exports = {
  startAuction, skipTurn, openBidding, closeBidding, openOpeningBid,
  sold, setStatus, emptyTeams,
  updateSettings,
  addCaptain, updateCaptain, deleteCaptain, importCaptains, moveCaptain,
  addPlayer, updatePlayer, deletePlayer, importPlayers, clearPool,
  assignPlayerToTeam, removePlayerFromTeam, setPlayerPrice,
};
