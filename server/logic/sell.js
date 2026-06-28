/**
 * Ending the bidding phase: the sold/last-bid clocks, the core sale, the AUTO-mode
 * auto-sell, and the uncontestable-bid auto-sell. Mutates state only; the caller persists
 * + notifies. Ported from SellHelpers.js (the script-property clocks are now state.clocks;
 * the Sold!-button cell is gone — "armed" is computed in soldButtonUsable()).
 */

const { state, playerById, captainById } = require('../state');
const { STATUS, SELL_MODE } = require('../config');
const team = require('./team');
const turn = require('./turn');

// ----- last-sale announcement (ephemeral) -----

function setLastSold(playerName, winnerName, bid) {
  state.clocks.lastSold = { player: playerName, winner: winnerName, bid, at: Date.now() };
}
function recentSoldMessage() {
  const d = state.clocks.lastSold;
  if (!d) return null;
  if (Date.now() - d.at > state.settings.soldMessageSeconds * 1000) return null;
  return { player: d.player, winner: d.winner, bid: d.bid };
}

// ----- last-bid clock + derived timers (ephemeral) -----

function setLastBidTime() { state.clocks.lastBidTime = Date.now(); }
function clearLastBidTime() { state.clocks.lastBidTime = 0; }

/** Seconds until the AUTO-mode auto-sell fires (for the captain countdown ring). */
function autoSellSecondsRemaining() {
  const lb = state.clocks.lastBidTime;
  if (!lb) return state.settings.autoWindow;
  return Math.max(0, Math.round(state.settings.autoWindow - (Date.now() - lb) / 1000));
}

/** True once the Sold-action arming cooldown has passed (both modes). */
function soldButtonUsable() {
  const lb = state.clocks.lastBidTime;
  if (!lb) return true;
  return Date.now() - lb >= state.settings.soldCooldown * 1000;
}

/** When the admin switches MANUAL→AUTO mid-bidding, restart the window from now so it
 *  doesn't fire instantly off a long-past bid. Called from the admin set-sell-mode handler. */
function reanchorAutoWindowOnSwitchToAuto() {
  if (state.settings.status === STATUS.BIDDING && state.clocks.lastBidTime) {
    setLastBidTime();
  }
}

// ----- core sale (state only) -----

function sellPlayerInner() {
  const a = state.auction;
  const player = a.currentPlayerId ? playerById(a.currentPlayerId) : null;
  const winner = a.byCaptainId ? captainById(a.byCaptainId) : null;
  const bid = a.highestBid;

  if (!player) return { ok: false, error: 'No player to assign.' };
  if (!winner) return { ok: false, error: 'No winning captain — nobody placed a bid.' };
  if (!team.placePlayerInTeam(winner, player, bid)) {
    return { ok: false, error: `Captain '${winner.name}' has no free slots left.` };
  }
  team.clearAuctionBlock();
  setLastSold(player.name, winner.name, bid);
  return { ok: true };
}

/** Sell the current player and advance the turn. Returns the sale result. */
function finalizeSaleAndAdvance() {
  const result = sellPlayerInner();
  if (!result.ok) return result;
  clearLastBidTime();
  turn.advanceTurn();
  return result;
}

// ----- uncontestable-bid auto-sell -----

function captainCanOutbid(captain, currentBid) {
  if (team.isCaptainFull(captain)) return false;
  return team.captainMaxBid(captain) > currentBid;
}

/** True when no captain other than `currentBidderId` can outbid `currentBid`. */
function noOneCanOutbid(currentBidderId, currentBid) {
  for (const c of state.captains) {
    if (c.id === currentBidderId) continue;
    if (captainCanOutbid(c, currentBid)) return false;
  }
  return true;
}

/**
 * Called right after a bid is written: if nobody else can outbid it, sell immediately and
 * advance; otherwise stamp the last-bid clock (which also re-arms the cooldown / restarts
 * the AUTO window). Returns true if the bid ended the lot (sold).
 */
function finalizeBid(bidderId, bid) {
  if (noOneCanOutbid(bidderId, bid) && finalizeSaleAndAdvance().ok) return true;
  setLastBidTime();
  return false;
}

/** AUTO mode: if the no-new-bid window elapsed, sell to the high bidder + advance.
 *  Returns true if it sold (so the timer can persist + broadcast). */
function autoSellIfElapsed() {
  if (state.settings.sellMode !== SELL_MODE.AUTO) return false;
  if (state.settings.status !== STATUS.BIDDING) return false;
  const lb = state.clocks.lastBidTime;
  if (!lb) return false;
  if (Date.now() - lb < state.settings.autoWindow * 1000) return false;
  return finalizeSaleAndAdvance().ok;
}

module.exports = {
  recentSoldMessage,
  setLastBidTime,
  clearLastBidTime,
  autoSellSecondsRemaining,
  soldButtonUsable,
  reanchorAutoWindowOnSwitchToAuto,
  sellPlayerInner,
  finalizeSaleAndAdvance,
  captainCanOutbid,
  noOneCanOutbid,
  finalizeBid,
  autoSellIfElapsed,
};
