/**
 * Team / roster logic and the values the Google Sheet used to compute with formulas:
 * a captain's max bid, whether their team is full, the open-player pool, and per-team
 * role flags. Pure with respect to persistence — these read/mutate the in-memory state
 * only; the action layer persists.
 *
 * Ported from TeamHelpers.js (plus the max-bid/full/role-flag formulas the sheet owned).
 */

const { state, draftedPlayers, openPlayers, nextSoldSeq } = require('../state');
const { ROLE_LABELS, PLAYER_SHUFFLE_SEED, PLAYER_STATUS, POOL_ORDER } = require('../config');

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

/** Unspent budget: budget − (captain price + bought players). Can't go below 0 on the board. */
function remainingBudget(captain) {
  if (!captain) return 0;
  return Math.max(0, state.settings.teamBudget - spentByCaptain(captain));
}

/**
 * Highest amount this captain can bid on the next player: simply their remaining budget (#7).
 * There's no reserve for the other empty slots any more — a captain who runs out goes broke and
 * fills the rest in the fill-up round. 0 when the team is full.
 */
function captainMaxBid(captain) {
  if (!captain) return 0;
  if (isCaptainFull(captain)) return 0;
  return remainingBudget(captain);
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

// ----- tiers -----

/** The tier object for an id (settings.tiers), or null for no tier / a deleted tier. */
function tierById(id) {
  if (id == null) return null;
  return (state.settings.tiers || []).find((t) => t.id === id) || null;
}

/** The price ceiling of a player's tier (null: untiered, or the tier has no ceiling). */
function priceCeiling(player) {
  const t = player ? tierById(player.tierId) : null;
  return t && t.rangeMax != null ? t.rangeMax : null;
}

/** A bid above the player's tier price ceiling (shown red; never blocked). */
function isAboveCeiling(player, bid) {
  const c = priceCeiling(player);
  return c != null && bid > c;
}

/** The base ("lowest") tier: the smallest minBid, ties going to the earlier tier on the Tiers card.
 *  null when no tiers are configured. */
function lowestTier() {
  let best = null;
  for (const t of state.settings.tiers || []) if (!best || t.minBid < best.minBid) best = t;
  return best;
}

/** Minimum opening bid for an untiered player: the lowest tier's minimum, or the default min bid
 *  (settings.smallBlind) when there are no tiers at all. */
function defaultMinBid() {
  const t = lowestTier();
  return t ? t.minBid : state.settings.smallBlind;
}

/** Minimum opening bid for a player: its tier's minBid, or defaultMinBid() if untiered. */
function playerMinBid(player) {
  const tier = player ? tierById(player.tierId) : null;
  return tier ? tier.minBid : defaultMinBid();
}

// ----- broke captains (#7) -----

/** The cheapest minimum opening bid among players still in the pool, or null if the pool is empty. */
function cheapestOpenMinBid() {
  let min = null;
  for (const p of openPlayers()) {
    const m = playerMinBid(p);
    if (min === null || m < min) min = m;
  }
  return min;
}

/**
 * Broke: the team isn't full, but the captain can't afford any player left — their remaining budget
 * is $0, or below the cheapest minimum opening bid in the pool (an empty pool counts as nothing
 * affordable). Broke captains can't bid or open, are skipped in the turn order, and fill their
 * remaining slots in the fill-up round. Derived live; brokeSeq (below) only records *when*.
 */
function isCaptainBroke(captain) {
  if (!captain || isCaptainFull(captain)) return false;
  const left = remainingBudget(captain);
  if (left <= 0) return true;
  const cheapest = cheapestOpenMinBid();
  return cheapest === null || left < cheapest;
}

/**
 * Records the moment captains go broke, for the fill-up pick order (reverse broke order). Call once
 * per action, after it mutated state. Everyone who goes broke in the same action shares one brokeSeq
 * (ties are broken later) and gets a random brokeTie, rolled once so the order doesn't reshuffle.
 * A captain who is no longer broke (e.g. after an admin edit) loses their place.
 */
function updateBrokeState() {
  let nextSeq = 1;
  for (const c of state.captains) if ((c.brokeSeq || 0) >= nextSeq) nextSeq = c.brokeSeq + 1;
  for (const c of state.captains) {
    if (isCaptainBroke(c)) {
      if (!c.brokeSeq) { c.brokeSeq = nextSeq; c.brokeTie = Math.floor(Math.random() * 1e9); }
    } else if (c.brokeSeq) {
      c.brokeSeq = 0;
      c.brokeTie = 0;
    }
  }
}

/** { name: true|false } — broke flags for the board's turn rail (like fullByName). */
function brokeByName() {
  const m = {};
  for (const c of state.captains) m[c.name] = isCaptainBroke(c);
  return m;
}

// ----- open-player pool -----

/** Open players as [{name, tier, minBid}], sorted alphabetically — for the captain's opening-bid
 *  dropdown. `tier` is the tier name ('' if untiered); `minBid` is that player's minimum opening bid. */
function openPlayersForOpening() {
  return openPlayers()
    .map((p) => {
      const tier = tierById(p.tierId);
      return { name: p.name, tier: tier ? tier.name : '', minBid: playerMinBid(p) };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** URL of a player's uploaded card image ('' if none). */
function playerImageUrl(p) {
  return p && p.image ? '/uploads/' + p.image : '';
}

/** Open players as [{name, role, tierId, image}] for the spectator board (tierId null if untiered,
 *  image = card URL or '').
 *  Ordered per settings.poolOrder: ALPHABETICAL (by name) or, by default, a deterministic seeded
 *  shuffle (stable, random-looking). */
function openPlayersWithRoles() {
  const out = openPlayers().map((p) => ({ name: p.name, role: p.role, tierId: tierById(p.tierId) ? p.tierId : null, image: playerImageUrl(p) }));
  if (state.settings.poolOrder === POOL_ORDER.ALPHABETICAL) {
    out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  } else {
    out.sort((a, b) => {
      const ka = shuffleKey(a.name), kb = shuffleKey(b.name);
      return ka === kb ? a.name.localeCompare(b.name) : ka - kb;
    });
  }
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
  player.soldSeq = nextSoldSeq();          // record acquisition order for stable slot display
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
  remainingBudget,
  captainMaxBid,
  fullByName,
  lowestTier,
  defaultMinBid,
  cheapestOpenMinBid,
  isCaptainBroke,
  updateBrokeState,
  brokeByName,
  roleMatches,
  captainRoleFlags,
  tierById,
  priceCeiling,
  isAboveCeiling,
  playerMinBid,
  openPlayersForOpening,
  openPlayersWithRoles,
  playerImageUrl,
  shuffleKey,
  placePlayerInTeam,
  clearAuctionBlock,
};
