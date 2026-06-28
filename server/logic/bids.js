/**
 * Captain-facing actions: place an opening bid, place a regular bid, skip a turn. This is
 * the orchestration layer — it validates, mutates state via team/turn/sell, then persists
 * once and notifies (markChanged). Because it is fully synchronous, each call is an atomic
 * read-modify-write; concurrent captains are serialized by the event loop (no locking).
 *
 * The caller (routes/ws) resolves + authenticates the captain and passes the captain object.
 * Return shape is { ok, error } — identical to the old Apps Script placeBid/placeOpeningBid.
 *
 * Ported from WebApp.js placeBid / placeOpeningBid / skipTurn.
 */

const { state, persistAll, playerByName } = require('../state');
const { STATUS, PLAYER_STATUS } = require('../config');
const { markChanged } = require('../bus');
const team = require('./team');
const turn = require('./turn');
const sell = require('./sell');

function validBidAmount(amount) {
  const bid = Number(amount);
  if (!Number.isFinite(bid) || bid <= 0) return { ok: false, error: 'Invalid bid.' };
  if (!Number.isInteger(bid)) return { ok: false, error: 'Bid must be a whole number.' };
  return { ok: true, bid };
}

function placeBid(captain, amount) {
  if (state.settings.status !== STATUS.BIDDING) return { ok: false, error: 'Bidding is closed.' };
  if (team.isCaptainFull(captain)) return { ok: false, error: 'Your team is full.' };

  const v = validBidAmount(amount);
  if (!v.ok) return v;
  const bid = v.bid;

  if (bid <= state.auction.highestBid) {
    return { ok: false, error: `Bid must be higher than $${state.auction.highestBid}.` };
  }
  const maxBid = team.captainMaxBid(captain);
  if (maxBid && bid > maxBid) return { ok: false, error: `Exceeds your max bid of $${maxBid}.` };

  state.auction.highestBid = bid;
  state.auction.byCaptainId = captain.id;
  sell.finalizeBid(captain.id, bid);   // may auto-sell + advance if uncontestable
  persistAll();
  markChanged();
  return { ok: true };
}

function placeOpeningBid(captain, playerName, amount) {
  if (state.settings.status !== STATUS.OPENING) return { ok: false, error: 'Not currently in opening bid phase.' };
  if (team.isCaptainFull(captain)) return { ok: false, error: 'Your team is full.' };

  const cur = turn.currentTurnCaptain();
  if (!cur || cur.id !== captain.id) return { ok: false, error: "It's not your turn to open." };

  const player = playerByName(playerName);
  if (!player || player.status !== PLAYER_STATUS.OPEN) {
    return { ok: false, error: "That player isn't in the open pool." };
  }

  const v = validBidAmount(amount);
  if (!v.ok) return v;
  const bid = v.bid;

  const smallBlind = state.settings.smallBlind;
  if (bid < smallBlind) return { ok: false, error: `Opening bid must be at least $${smallBlind}.` };

  const maxBid = team.captainMaxBid(captain);
  if (maxBid && bid > maxBid) return { ok: false, error: `Exceeds your max bid of $${maxBid}.` };

  state.auction.currentPlayerId = player.id;
  state.auction.highestBid = bid;
  state.auction.byCaptainId = captain.id;
  state.settings.status = STATUS.BIDDING;
  sell.finalizeBid(captain.id, bid);
  persistAll();
  markChanged();
  return { ok: true };
}

function skipTurn(captain) {
  if (state.settings.status !== STATUS.OPENING) {
    return { ok: false, error: 'Nothing to skip — not in opening bid phase.' };
  }
  const cur = turn.currentTurnCaptain();
  if (!cur || cur.id !== captain.id) return { ok: false, error: "It's not your turn." };

  turn.skipTurnAdvance();
  persistAll();
  markChanged();
  return { ok: true };
}

module.exports = { placeBid, placeOpeningBid, skipTurn };
