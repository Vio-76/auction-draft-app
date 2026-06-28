/**
 * Team / roster logic and the values the Google Sheet used to compute with formulas:
 * a captain's max bid, whether their team is full, the open-player pool, and per-team
 * role flags. Pure with respect to persistence — these read/mutate the in-memory state
 * only; the action layer persists.
 *
 * Ported from TeamHelpers.js (plus the max-bid/full/role-flag formulas the sheet owned).
 */

const { state, draftedPlayers, openPlayers } = require('../state');
const { ROLE_LABELS, PLAYER_SHUFFLE_SEED, PLAYER_STATUS } = require('../config');

// ----- derived team values -----

function draftedCount(captain) {
  return draftedPlayers(captain.id).length;
}

function spentByCaptain(captain) {
  let spent = captain.price || 0;                     // the captain's own cost counts
  for (const p of draftedPlayers(captain.id)) spent += p.price || 0;
  return spent;
}

function isCaptainFull(captain) {
  if (!captain) return false;
  return draftedCount(captain) >= state.settings.teamSlots;
}

/**
 * Highest amount this captain can still bid on the NEXT player:
 *   budget − (captain price + bought players) − smallBlind × (other empty slots)
 * i.e. enough budget must remain to fill every remaining slot at the minimum price.
 * Returns 0 when the team is full or fully priced out. (Replaces the Auth-sheet column
 * the old readCaptainMaxBid read; the sheet computed exactly this.)
 */
function captainMaxBid(captain) {
  if (!captain) return 0;
  const { teamBudget, teamSlots, smallBlind } = state.settings;
  const empty = teamSlots - draftedCount(captain);
  if (empty <= 0) return 0;
  const reserve = smallBlind * (empty - 1);           // reserve min cost for the OTHER empty slots
  return Math.max(0, teamBudget - spentByCaptain(captain) - reserve);
}

/** { "Monarch": false, "Tomi": true, ... } — used by the turn walker and outbid checks. */
function fullByName() {
  const m = {};
  for (const c of state.captains) m[c.name] = isCaptainFull(c);
  return m;
}

// ----- roles -----

/** Match a player's role to a role label on the first 3 letters (case-insensitive),
 *  mirroring the board's pool bucketing (e.g. "jun" → "Jungle"). */
function roleMatches(playerRole, label) {
  return String(playerRole || '').toLowerCase().slice(0, 3) === label.toLowerCase().slice(0, 3);
}

/** [true,false,...] in ROLE_LABELS order: whether the team covers each role. The captain's
 *  own role counts toward coverage, alongside their drafted players. */
function captainRoleFlags(captain) {
  const drafted = draftedPlayers(captain.id);
  return ROLE_LABELS.map((label) =>
    roleMatches(captain.role, label) || drafted.some((p) => roleMatches(p.role, label)));
}

// ----- open-player pool -----

/** Open player names, sorted alphabetically — for the captain's opening-bid dropdown. */
function openPlayerNames() {
  return openPlayers()
    .map((p) => p.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/** Open players as [{name, role}], deterministically shuffled — for the spectator board. */
function openPlayersWithRoles() {
  const out = openPlayers().map((p) => ({ name: p.name, role: p.role }));
  out.sort((a, b) => {
    const ka = shuffleKey(a.name), kb = shuffleKey(b.name);
    return ka === kb ? a.name.localeCompare(b.name) : ka - kb;
  });
  return out;
}

/** Deterministic 32-bit FNV-1a hash of the seeded name — stable, random-looking sort key. */
function shuffleKey(name) {
  const s = PLAYER_SHUFFLE_SEED + '|' + name;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ----- mutators (state only; caller persists) -----

/** Assigns `player` to `captain` at price `price`. Returns false if the team is full. */
function placePlayerInTeam(captain, player, price) {
  if (isCaptainFull(captain)) return false;
  player.status = PLAYER_STATUS.SOLD;
  player.captainId = captain.id;
  player.price = price;
  return true;
}

/** Clears the live auction block (current player / bid / bidder). */
function clearAuctionBlock() {
  state.auction.currentPlayerId = null;
  state.auction.highestBid = 0;
  state.auction.byCaptainId = null;
}

module.exports = {
  draftedCount,
  spentByCaptain,
  isCaptainFull,
  captainMaxBid,
  fullByName,
  roleMatches,
  captainRoleFlags,
  openPlayerNames,
  openPlayersWithRoles,
  shuffleKey,
  placePlayerInTeam,
  clearAuctionBlock,
};
