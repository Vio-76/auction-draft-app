/**
 * Fill-up round (#7): after the auction phase, broke captains fill their remaining slots with $0
 * picks, one captain at a time, in a stack order (last to go broke picks first).
 *
 * State lives in settings (persisted, survives a restart):
 *   fillOrder  — captain ids still to pick, TOP FIRST (fillOrder[0] is picking)
 *   fillDone   — captain ids that finished (team full), in the order they finished
 *   fillQuota  — { tierId: picks left } for tiers above the base tier (see computeQuotas)
 * Mutates state only; the caller persists + notifies.
 */

const { state, captainById, openPlayers } = require('../state');
const { STATUS } = require('../config');
const team = require('./team');

// ----- order -----

/**
 * Pick order for broke captains, top (picks first) to bottom:
 *   1. went broke later picks first (higher brokeSeq),
 *   then, for captains who went broke at the same moment:
 *   2. more remaining budget first, 3. fewer open slots first, 4. lower captain price first,
 *   5. the random brokeTie rolled when they went broke.
 */
function compareFillOrder(a, b) {
  return (b.brokeSeq || 0) - (a.brokeSeq || 0)
    || team.remainingBudget(b) - team.remainingBudget(a)
    || openSlots(a) - openSlots(b)
    || (a.price || 0) - (b.price || 0)
    || (a.brokeTie || 0) - (b.brokeTie || 0)
    || a.id - b.id;
}

function openSlots(captain) {
  return Math.max(0, state.settings.teamSlots - team.draftedCount(captain));
}

/** The stack as it stands: during FILLUP the stored order; before that, the projected order of the
 *  captains who are broke right now (it grows as more go broke during the auction). */
function currentOrder() {
  if (state.settings.status === STATUS.FILLUP) {
    return (state.settings.fillOrder || []).map(captainById).filter(Boolean);
  }
  return state.captains.filter((c) => team.isCaptainBroke(c)).sort(compareFillOrder);
}

function currentPicker() {
  if (state.settings.status !== STATUS.FILLUP) return null;
  const id = (state.settings.fillOrder || [])[0];
  return id != null ? captainById(id) : null;
}

// ----- eligibility -----

/** Base tier = the lowest tier plus every untiered player. With no tiers, every player is base. */
function isBasePlayer(player) {
  const tier = team.tierById(player.tierId);
  if (!tier) return true;
  const low = team.lowestTier();
  return !!low && tier.id === low.id;
}

/** Tiers above the base tier, "next tier up" first: by min bid, ties in Tiers-card order. */
function tiersAboveBase() {
  const low = team.lowestTier();
  return (state.settings.tiers || [])
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => !low || t.id !== low.id)
    .sort((x, y) => x.t.minBid - y.t.minBid || x.i - y.i)
    .map(({ t }) => t);
}

/**
 * Quotas for the tiers above base, computed once when the round starts. Every base player is
 * pickable; if the broke teams need more players than the base tier has, the difference comes
 * from the next tier up, then the one above that, and so on.
 */
function computeQuotas(totalSlots) {
  const open = openPlayers();
  const baseCount = open.filter(isBasePlayer).length;
  let extra = Math.max(0, totalSlots - baseCount);
  const quota = {};
  for (const t of tiersAboveBase()) {
    const inTier = open.filter((p) => p.tierId === t.id).length;
    const q = Math.min(extra, inTier);
    quota[t.id] = q;
    extra -= q;
  }
  return quota;
}

function quotaLeft(tierId) {
  return Number((state.settings.fillQuota || {})[tierId]) || 0;
}

function isEligible(player) {
  if (!player || player.status !== 'open') return false;
  if (isBasePlayer(player)) return true;
  return quotaLeft(player.tierId) > 0;
}

function eligiblePlayers() {
  return openPlayers().filter(isEligible);
}

/** For the captain's pick dropdown: [{ label, base, quotaLeft, players:[name] }] — base group first,
 *  then each tier above base that still has picks left, players alphabetical. */
function pickGroups() {
  const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  const open = openPlayers();
  const groups = [];
  const low = team.lowestTier();
  const base = open.filter(isBasePlayer).map((p) => p.name).sort(byName);
  if (base.length) groups.push({ label: low ? low.name : 'Players', base: true, quotaLeft: null, players: base });
  for (const t of tiersAboveBase()) {
    const left = quotaLeft(t.id);
    if (left <= 0) continue;
    const players = open.filter((p) => p.tierId === t.id).map((p) => p.name).sort(byName);
    if (players.length) groups.push({ label: t.name, base: false, quotaLeft: left, players });
  }
  return groups;
}

// ----- lifecycle -----

/** Clear all fill-up state (a new auction start). */
function reset() {
  state.settings.fillOrder = [];
  state.settings.fillDone = [];
  state.settings.fillQuota = {};
}

/**
 * Start the round: called when the auction phase has no eligible captain left but someone is
 * broke. Freezes the order + quotas, clears the auction block, then settles (which may finish
 * straight away, e.g. if the pool is empty).
 */
function start() {
  const order = state.captains.filter((c) => team.isCaptainBroke(c)).sort(compareFillOrder);
  const totalSlots = order.reduce((n, c) => n + openSlots(c), 0);
  state.settings.status = STATUS.FILLUP;
  state.settings.marker = -1;
  state.settings.fillOrder = order.map((c) => c.id);
  state.settings.fillDone = [];
  state.settings.fillQuota = computeQuotas(totalSlots);
  team.clearAuctionBlock();
  settle();
}

/**
 * Take every captain whose team is now full off the stack (normally the top one after their last
 * pick; anywhere, if the admin assigned players by hand). Finishes the auction when the stack is
 * empty or nothing pickable is left.
 */
function settle() {
  if (state.settings.status !== STATUS.FILLUP) return;
  const order = [];
  const done = (state.settings.fillDone || []).slice();
  for (const id of state.settings.fillOrder || []) {
    const c = captainById(id);
    if (!c) continue;                                    // captain deleted
    if (team.isCaptainFull(c)) done.push(id); else order.push(id);
  }
  state.settings.fillOrder = order;
  state.settings.fillDone = done;
  if (!order.length || !eligiblePlayers().length) {
    state.settings.status = STATUS.FINISHED;
  }
}

/** Use up one quota pick if `player` is above the base tier (any $0 fill-up placement). */
function consumeQuota(player) {
  if (isBasePlayer(player)) return;
  const q = { ...(state.settings.fillQuota || {}) };
  if ((Number(q[player.tierId]) || 0) > 0) q[player.tierId] = Number(q[player.tierId]) - 1;
  state.settings.fillQuota = q;
}

/** A captain's $0 pick. Returns { ok, error? }; the caller persists + notifies. */
function pick(captain, playerName, { playerByName, setLastPick }) {
  if (state.settings.status !== STATUS.FILLUP) return { ok: false, error: 'The fill-up round isn\'t running.' };
  const picker = currentPicker();
  if (!picker || picker.id !== captain.id) return { ok: false, error: "It's not your pick." };
  const player = playerByName(playerName);
  if (!player || player.status !== 'open') return { ok: false, error: "That player isn't in the pool." };
  if (!isEligible(player)) return { ok: false, error: `No picks left from ${team.tierById(player.tierId)?.name || 'that tier'}.` };
  if (!team.placePlayerInTeam(captain, player, 0)) return { ok: false, error: 'Your team is full.' };
  consumeQuota(player);
  setLastPick(player.name, captain.name);
  settle();
  return { ok: true };
}

/** Admin: move a captain one place up/down in the remaining fill-up stack (index 0 = picks next). */
function move(captainId, dir) {
  if (state.settings.status !== STATUS.FILLUP) return { ok: false, error: 'The fill-up round isn\'t running.' };
  const order = (state.settings.fillOrder || []).slice();
  const i = order.indexOf(Number(captainId));
  if (i < 0) return { ok: false, error: 'That captain isn\'t in the fill-up order.' };
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= order.length) return { ok: true };
  [order[i], order[j]] = [order[j], order[i]];
  state.settings.fillOrder = order;
  return { ok: true };
}

module.exports = {
  compareFillOrder, openSlots, currentOrder, currentPicker,
  isBasePlayer, tiersAboveBase, computeQuotas, quotaLeft, isEligible, eligiblePlayers, pickGroups,
  reset, start, settle, consumeQuota, pick, move,
};
