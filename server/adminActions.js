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
  state, persistAll, nextCaptainId, nextPlayerId, nextSoldSeq,
  captainById, playerById, captainsBySeat,
} = require('./state');
const { STATUS, SELL_MODE, TURN_ORDER, TURN_DIR, POOL_ORDER, PLAYER_STATUS, THEME_FONT_URLS } = require('./config');
const { markChanged } = require('./bus');
const { saveImage, deleteImage } = require('./uploads');
const team = require('./logic/team');
const turn = require('./logic/turn');
const sell = require('./logic/sell');
const fillup = require('./logic/fillup');

function commit() {
  // The paused-countdown snapshot is only meaningful while CLOSED; clear it on resume.
  if (state.settings.status !== STATUS.CLOSED) state.clocks.pausedRemaining = null;
  // Admin edits (prices, rosters, pool, budget, tiers) can make captains go broke or stop being broke.
  team.updateBrokeState();
  // Fill-up round: a hand-assigned player can complete a team (take it off the stack) or end the round.
  fillup.settle();
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
  fillup.reset();
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
  if (state.settings.status === STATUS.FILLUP) {
    return err('Skip Turn isn\'t used in the fill-up round. Pick for a captain with Assign, or reorder the fill-up order.');
  }
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
    // Co-captains are pre-assigned by the admin and belong to their team, so they stay.
    if (p.status === PLAYER_STATUS.SOLD && !p.coCaptain) { p.status = PLAYER_STATUS.OPEN; p.captainId = null; p.price = 0; }
  }
  return ok();
}

// ----- settings -----

const NUMERIC_SETTINGS = ['smallBlind', 'teamBudget', 'teamSlots', 'openingTimeout', 'autoWindow', 'soldCooldown', 'openingMessageSeconds', 'soldMessageSeconds'];

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
    } else if (key === 'poolOrder') {
      if (raw !== POOL_ORDER.RANDOM && raw !== POOL_ORDER.ALPHABETICAL) return err('Invalid pool order.');
      state.settings.poolOrder = raw;
    } else if (key === 'turnDirection') {
      state.settings.turnDirection = (raw === 'UP' || raw === -1) ? TURN_DIR.UP : TURN_DIR.DOWN;
    } else if (key === 'theme') {
      state.settings.theme = THEME_FONT_URLS[raw] ? raw : 'draftroom';
    } else if (key === 'showBidOnBoard') {
      state.settings.showBidOnBoard = (raw === true || raw === 'true' || raw === 1 || raw === '1' || raw === 'on');
    } else if (key === 'showBudgetOnBoard') {
      state.settings.showBudgetOnBoard = (raw === true || raw === 'true' || raw === 1 || raw === '1' || raw === 'on');
    } else if (key === 'teamIdentityAlways') {
      state.settings.teamIdentityAlways = (raw === true || raw === 'true' || raw === 1 || raw === '1' || raw === 'on');
    } else if (key === 'showTeamNameOnBoard') {
      state.settings.showTeamNameOnBoard = (raw === true || raw === 'true' || raw === 1 || raw === '1' || raw === 'on');
    }
    // unknown keys ignored
  }

  // If we just switched MANUAL->AUTO mid-bidding, restart the window from now.
  if (!wasAuto && state.settings.sellMode === SELL_MODE.AUTO) sell.reanchorAutoWindowOnSwitchToAuto();
  return ok();
}

// ----- tiers -----

const MAX_TIERS = 20;
const MAX_TIER_NAME = 40;

/** Replace the whole tier list (admin Tiers card saves it in one go, in display order).
 *  `list`: [{ id?, name, minBid, rangeMin?, rangeMax? }]. The price range is the recommended price:
 *  the floor is display only; bids above the ceiling are flagged red (never blocked). Either may be
 *  empty (null). Existing ids are kept so player assignments survive a rename
 *  or re-price; rows without a known id get a fresh one. Tiers missing from the list are deleted
 *  and their players become untiered. Names must be unique (case-insensitive) since the bulk
 *  import matches tiers by name. */
function setTiers(list) {
  if (!Array.isArray(list)) return err('No tiers provided.');
  if (list.length > MAX_TIERS) return err(`At most ${MAX_TIERS} tiers.`);

  const existingIds = new Set((state.settings.tiers || []).map((t) => t.id));
  let nextId = Math.max(0, ...existingIds) + 1;
  const seenNames = new Set();
  const next = [];
  for (const raw of list) {
    const name = String((raw && raw.name) || '').trim();
    if (!name) return err('Every tier needs a name.');
    if (name.length > MAX_TIER_NAME) return err(`Tier names are limited to ${MAX_TIER_NAME} characters.`);
    if (name.includes(',')) return err('Tier names cannot contain commas (the bulk import splits on them).');
    const key = name.toLowerCase();
    if (seenNames.has(key)) return err(`Duplicate tier name "${name}".`);
    seenNames.add(key);

    const minBid = Number(raw.minBid);
    if (!Number.isInteger(minBid) || minBid < 0) return err(`Min bid for "${name}" must be a whole number ≥ 0.`);

    const id = existingIds.has(Number(raw.id)) ? Number(raw.id) : nextId++;
    const rangeMin = rangeNumber(raw.rangeMin);
    const rangeMax = rangeNumber(raw.rangeMax);
    if (rangeMin === undefined || rangeMax === undefined) return err(`Price range for "${name}" must be whole numbers ≥ 0 (or empty).`);
    if (rangeMin != null && rangeMax != null && rangeMax < rangeMin) {
      return err(`Price range for "${name}": the ceiling ($${rangeMax}) can't be below the floor ($${rangeMin}).`);
    }

    next.push({ id, name, minBid, rangeMin, rangeMax });
  }

  const keptIds = new Set(next.map((t) => t.id));
  for (const p of state.players) {
    if (p.tierId != null && !keptIds.has(p.tierId)) p.tierId = null;
  }
  state.settings.tiers = next;   // always a fresh array (never mutate the shared DEFAULT_SETTINGS one)
  return ok();
}

/** A price-range bound from admin input: '' / null → null, a whole number ≥ 0 → it, else undefined (invalid). */
function rangeNumber(raw) {
  if (raw === '' || raw == null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** A tier id from admin input ('' / unknown → null). */
function normalizeTierId(raw) {
  if (raw === '' || raw == null) return null;
  const id = Number(raw);
  return team.tierById(id) ? id : null;
}

/** Tier id for a name from the bulk import (case-insensitive), or null. */
function tierIdByName(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  const t = (state.settings.tiers || []).find((x) => x.name.toLowerCase() === key);
  return t ? t.id : null;
}

// ----- name uniqueness -----
// Captains and players are looked up by name (invite links, opening bids), so names must be
// unique within each list. Compared trimmed + case-insensitive so "Faker" and "faker " clash.

const nameKey = (s) => String(s || '').trim().toLowerCase();

/** True if another row in `list` (other than `exceptId`) already has this name. */
function nameTaken(list, name, exceptId) {
  const k = nameKey(name);
  return list.some((x) => x.id !== exceptId && nameKey(x.name) === k);
}

/** Names from `incoming` that clash with `existing` rows or repeat within `incoming`. */
function duplicateNames(incoming, existing) {
  const seen = new Set(existing.map((x) => nameKey(x.name)));
  const dups = new Set();
  for (const n of incoming) {
    const k = nameKey(n);
    if (seen.has(k)) dups.add(n); else seen.add(k);
  }
  return [...dups];
}

// ----- captains CRUD -----

// Allowed team-group values (board display, once FINISHED). Anything else normalizes to ''.
// Legacy "Group A"/"Group B" values fold to the short "A"/"B" form.
const GROUP_VALUES = ['', 'A', 'B'];
const normalizeGroup = (g) => {
  let v = String(g || '').trim();
  if (v === 'Group A') v = 'A';
  else if (v === 'Group B') v = 'B';
  return GROUP_VALUES.includes(v) ? v : '';
};

function addCaptain({ name, code, price, role, seat, discord, teamGroup, teamName } = {}) {
  const nm = String(name || '').trim();
  if (!nm) return err('Captain name is required.');
  if (nameTaken(state.captains, nm)) return err(`A captain named "${nm}" already exists.`);
  const maxSeat = state.captains.reduce((m, c) => Math.max(m, c.seat), -1);
  const id = nextCaptainId();
  state.captains.push({
    id,
    name: nm,
    code: String(code || '').trim(),
    price: Math.max(0, Math.floor(Number(price) || 0)),
    role: String(role || '').trim(),
    seat: Number.isFinite(Number(seat)) ? Number(seat) : maxSeat + 1,
    discord: String(discord || '').trim(),
    teamGroup: normalizeGroup(teamGroup),
    teamName: String(teamName || '').trim(),
    logo: '',
  });
  normalizeSeats();
  commit();
  return { ok: true, id };   // id returned so the admin UI can attach a team logo to the new captain
}

/** Attach an uploaded team logo (base64 data URL) to a captain. Same storage rule as player
 *  images: the file goes to UPLOADS_DIR, only the bare filename is kept in state. */
function setCaptainLogo(id, dataUrl) {
  const c = captainById(Number(id));
  if (!c) return err('Unknown captain.');
  const res = saveImage('c' + c.id, dataUrl);
  if (!res.ok) return err(res.error);
  const previous = c.logo;
  c.logo = res.filename;
  if (previous && previous !== res.filename) deleteImage(previous);
  return ok();
}

function clearCaptainLogo(id) {
  const c = captainById(Number(id));
  if (!c) return err('Unknown captain.');
  const previous = c.logo;
  c.logo = '';
  if (previous) deleteImage(previous);
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
  if ('name' in patch) {
    const nm = String(patch.name).trim();
    if (!nm) return err('Name cannot be empty.');
    if (nameTaken(state.captains, nm, c.id)) return err(`A captain named "${nm}" already exists.`);
    c.name = nm;
  }
  if ('code' in patch) c.code = String(patch.code).trim();
  if ('price' in patch) c.price = Math.max(0, Math.floor(Number(patch.price) || 0));
  if ('role' in patch) c.role = String(patch.role).trim();
  if ('discord' in patch) c.discord = String(patch.discord).trim();
  if ('teamGroup' in patch) c.teamGroup = normalizeGroup(patch.teamGroup);
  if ('teamName' in patch) c.teamName = String(patch.teamName).trim();
  if ('seat' in patch) c.seat = Number(patch.seat);
  normalizeSeats();
  return ok();
}

/** Parse pasted captains: one per line, "name <tab|comma|2+ spaces> role, discord, code, price"
 *  — field order matches the captains table columns (only name required; the rest optional). */
function parseCaptainList(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\t|,|\s{2,}/).map((s) => s.trim());
    const name = parts[0];
    if (name) out.push({ name, role: parts[1] || '', discord: parts[2] || '', code: parts[3] || '', price: Number(parts[4]) || 0 });
  }
  return out;
}

/** Bulk import captains. 'replace' clears all captains first (their drafted players return
 *  to the pool); 'append' adds after the existing ones. Returns { ok, added }. */
function importCaptains(text, mode = 'replace') {
  const parsed = parseCaptainList(text);
  if (!parsed.length) return err('No captains found in the pasted text.');
  // Validate before mutating: 'replace' only has to be unique within the paste.
  const dups = duplicateNames(parsed.map((c) => c.name), mode === 'replace' ? [] : state.captains);
  if (dups.length) return err(`Duplicate captain names (nothing imported): ${dups.join(', ')}.`);

  if (mode === 'replace') {
    for (const p of state.players) {
      if (p.captainId != null) { p.status = PLAYER_STATUS.OPEN; p.captainId = null; p.price = 0; p.coCaptain = false; }
    }
    for (const c of state.captains) if (c.logo) deleteImage(c.logo);
    state.captains = [];
    state.settings.marker = -1;
    team.clearAuctionBlock();
  }
  let id = nextCaptainId();
  let seat = state.captains.reduce((m, c) => Math.max(m, c.seat), -1) + 1;
  for (const c of parsed) {
    state.captains.push({
      id: id++, name: c.name, code: c.code,
      price: Math.max(0, Math.floor(c.price)), role: c.role, seat: seat++, discord: c.discord || '', logo: '',
    });
  }
  normalizeSeats();
  commit();
  return { ok: true, added: parsed.length };
}

function deleteCaptain(id) {
  const cid = Number(id);
  const cap = captainById(cid);
  if (!cap) return err('Unknown captain.');
  if (cap.logo) deleteImage(cap.logo);
  // Return their drafted players to the pool.
  for (const p of state.players) {
    if (p.captainId === cid) { p.status = PLAYER_STATUS.OPEN; p.captainId = null; p.price = 0; p.coCaptain = false; }
  }
  state.captains = state.captains.filter((c) => c.id !== cid);
  if (state.auction.byCaptainId === cid) { state.auction.byCaptainId = null; }
  normalizeSeats();
  return ok();
}

// ----- players CRUD + import -----

function addPlayer({ name, role, discord, tierId } = {}) {
  const nm = String(name || '').trim();
  if (!nm) return err('Player name is required.');
  if (nameTaken(state.players, nm)) return err(`A player named "${nm}" already exists.`);
  const id = nextPlayerId();
  state.players.push({
    id, name: nm, role: String(role || '').trim(),
    status: PLAYER_STATUS.OPEN, captainId: null, price: 0, discord: String(discord || '').trim(), image: '',
    tierId: normalizeTierId(tierId),
  });
  commit();
  return { ok: true, id };   // id returned so the admin UI can attach an image to the new player
}

function updatePlayer(id, patch = {}) {
  const p = playerById(Number(id));
  if (!p) return err('Unknown player.');
  if ('name' in patch) {
    const nm = String(patch.name).trim();
    if (!nm) return err('Name cannot be empty.');
    if (nameTaken(state.players, nm, p.id)) return err(`A player named "${nm}" already exists.`);
    p.name = nm;
  }
  if ('role' in patch) p.role = String(patch.role).trim();
  if ('discord' in patch) p.discord = String(patch.discord).trim();
  if ('tierId' in patch) p.tierId = normalizeTierId(patch.tierId);
  return ok();
}

/** Attach an uploaded image (base64 data URL) to a player. Writes the file to disk, stores only
 *  the bare filename in state, and deletes any previous file. Kept out of updatePlayer's generic
 *  patch path so the file I/O only runs on an actual image change. */
function setPlayerImage(id, dataUrl) {
  const p = playerById(Number(id));
  if (!p) return err('Unknown player.');
  const res = saveImage('p' + p.id, dataUrl);
  if (!res.ok) return err(res.error);
  const previous = p.image;
  p.image = res.filename;
  if (previous && previous !== res.filename) deleteImage(previous);
  return ok();
}

function clearPlayerImage(id) {
  const p = playerById(Number(id));
  if (!p) return err('Unknown player.');
  const previous = p.image;
  p.image = '';
  if (previous) deleteImage(previous);
  return ok();
}

function deletePlayer(id) {
  const pid = Number(id);
  const p = playerById(pid);
  if (!p) return err('Unknown player.');
  if (p.image) deleteImage(p.image);
  state.players = state.players.filter((x) => x.id !== pid);
  if (state.auction.currentPlayerId === pid) team.clearAuctionBlock();
  return ok();
}

/** Parse pasted text: one player per line, "name <tab|comma|2+ spaces> role, discord, tier"
 *  — field order matches the players table columns (role, discord, tier optional; tier by name). */
function parsePlayerList(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\t|,|\s{2,}/).map((s) => s.trim());
    const name = parts[0];
    if (name) out.push({ name, role: parts[1] || '', discord: parts[2] || '', tier: parts[3] || '' });
  }
  return out;
}

/** Bulk import. mode 'replace' clears the current OPEN pool first (drafted players kept);
 *  'append' adds to it. A tier name that matches no configured tier imports as untiered and is
 *  reported back. Returns { ok, added, unknownTiers }. */
function importPlayers(text, mode = 'replace') {
  const parsed = parsePlayerList(text);
  if (!parsed.length) return err('No players found in the pasted text.');
  // Validate before mutating: 'replace' keeps drafted players, so check against those.
  const kept = mode === 'replace' ? state.players.filter((p) => p.status === PLAYER_STATUS.SOLD) : state.players;
  const dups = duplicateNames(parsed.map((p) => p.name), kept);
  if (dups.length) return err(`Duplicate player names (nothing imported): ${dups.join(', ')}.`);

  if (mode === 'replace') {
    state.players = state.players.filter((p) => p.status === PLAYER_STATUS.SOLD);
    if (state.auction.currentPlayerId && !playerById(state.auction.currentPlayerId)) team.clearAuctionBlock();
  }
  const unknownTiers = new Set();
  let id = nextPlayerId();
  for (const { name, role, discord, tier } of parsed) {
    const tierId = tierIdByName(tier);
    if (tier && tierId == null) unknownTiers.add(tier);
    state.players.push({ id: id++, name, role, status: PLAYER_STATUS.OPEN, captainId: null, price: 0, discord: discord || '', image: '', tierId });
  }
  commit();
  return { ok: true, added: parsed.length, unknownTiers: [...unknownTiers] };
}

function clearPool() {
  state.players = state.players.filter((p) => p.status === PLAYER_STATUS.SOLD);
  return ok();
}

// ----- manual roster editing -----

function assignPlayerToTeam(playerId, captainId, price, coCaptain = false) {
  const p = playerById(Number(playerId));
  if (!p) return err('Unknown player.');
  const c = captainById(Number(captainId));
  if (!c) return err('Unknown captain.');
  const co = coCaptain === true || coCaptain === 'true' || coCaptain === 1 || coCaptain === '1';
  if (co && state.players.some((x) => x.id !== p.id && x.coCaptain && x.captainId === c.id)) {
    return err(`${c.name}'s team already has a co-captain.`);
  }
  p.coCaptain = co;
  const wasSold = p.status === PLAYER_STATUS.SOLD;
  p.status = PLAYER_STATUS.SOLD;
  p.captainId = c.id;
  p.price = Math.max(0, Math.floor(Number(price) || 0));
  // Fresh assignment from the pool appends to the end; editing an existing pick's team/price
  // keeps its current slot.
  if (!wasSold) p.soldSeq = nextSoldSeq();
  // During the fill-up round the admin picks for captains with Assign; it uses up a tier quota too.
  if (!wasSold && state.settings.status === STATUS.FILLUP) fillup.consumeQuota(p);
  return ok();
}

function removePlayerFromTeam(playerId) {
  const p = playerById(Number(playerId));
  if (!p) return err('Unknown player.');
  p.status = PLAYER_STATUS.OPEN;
  p.captainId = null;
  p.price = 0;
  p.soldSeq = 0;
  p.coCaptain = false;
  return ok();
}

function setPlayerPrice(playerId, price) {
  const p = playerById(Number(playerId));
  if (!p) return err('Unknown player.');
  p.price = Math.max(0, Math.floor(Number(price) || 0));
  return ok();
}

/** Admin: reorder the fill-up stack (one place up/down). */
function moveFillUp(captainId, dir) {
  const r = fillup.move(captainId, dir);
  if (!r.ok) return r;
  return ok();
}

module.exports = {
  moveFillUp,
  startAuction, skipTurn, openBidding, closeBidding, openOpeningBid,
  sold, setStatus, emptyTeams,
  updateSettings, setTiers,
  addCaptain, updateCaptain, deleteCaptain, importCaptains, moveCaptain,
  setCaptainLogo, clearCaptainLogo,
  addPlayer, updatePlayer, deletePlayer, importPlayers, clearPool,
  setPlayerImage, clearPlayerImage,
  assignPlayerToTeam, removePlayerFromTeam, setPlayerPrice,
};
