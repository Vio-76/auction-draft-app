'use strict';
// Isolated in-memory DB before anything requires db.js.
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');

const { state, load, persistAll } = require('../server/state');
const { STATUS, SELL_MODE, TURN_ORDER, TURN_DIR, PLAYER_STATUS, DEFAULT_SETTINGS } = require('../server/config');
const team = require('../server/logic/team');
const turn = require('../server/logic/turn');
const sell = require('../server/logic/sell');
const bids = require('../server/logic/bids');

load();

// Reset the singleton to a known scenario.
function setup({ settings = {}, captains = [], players = [] } = {}) {
  Object.assign(state.settings, DEFAULT_SETTINGS, settings);
  state.captains = captains.map((c, i) => ({
    id: i + 1, name: c.name, code: c.code || 'c', price: c.price || 0, seat: c.seat ?? i,
  }));
  state.players = players.map((p, i) => ({
    id: i + 1, name: p.name, role: p.role || '', status: p.status || PLAYER_STATUS.OPEN,
    captainId: p.captainId ?? null, price: p.price || 0,
  }));
  state.auction = { currentPlayerId: null, highestBid: 0, byCaptainId: null };
  state.clocks = { openingDeadline: 0, lastBidTime: 0, lastSold: null, previousSellMode: null };
  persistAll();
}

const idsOf = (a) => a.map((x) => x.id);

// ---------- pure walkers ----------

test('waterfall: steps forward and wraps, skipping full', () => {
  const caps = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const none = () => false;
  assert.equal(turn.findNextAvailableIndex(-1, caps, none), 0);
  assert.equal(turn.findNextAvailableIndex(0, caps, none), 1);
  assert.equal(turn.findNextAvailableIndex(2, caps, none), 0); // wrap
  const id2full = (c) => c.id === 2;
  assert.equal(turn.findNextAvailableIndex(0, caps, id2full), 2); // skip the full one
});

test('waterfall: all full returns -1', () => {
  const caps = [{ id: 1 }, { id: 2 }];
  assert.equal(turn.findNextAvailableIndex(0, caps, () => true), -1);
});

test('snake: bounces at the ends with the end captain back-to-back', () => {
  const caps = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const none = () => false;
  // fresh start
  assert.deepEqual(turn.findNextSnakeIndex(-1, TURN_DIR.DOWN, caps, none), { idx: 0, direction: TURN_DIR.DOWN });
  // middle
  assert.deepEqual(turn.findNextSnakeIndex(0, TURN_DIR.DOWN, caps, none), { idx: 1, direction: TURN_DIR.DOWN });
  // hit the bottom: stay on index 2, flip to UP (back-to-back)
  assert.deepEqual(turn.findNextSnakeIndex(2, TURN_DIR.DOWN, caps, none), { idx: 2, direction: TURN_DIR.UP });
  // hit the top: stay on index 0, flip to DOWN
  assert.deepEqual(turn.findNextSnakeIndex(0, TURN_DIR.UP, caps, none), { idx: 0, direction: TURN_DIR.DOWN });
});

// ---------- max bid / full ----------

test('captainMaxBid reserves the small blind for remaining empty slots', () => {
  setup({
    settings: { teamBudget: 100, teamSlots: 4, smallBlind: 1 },
    captains: [{ name: 'A', price: 5 }],
  });
  const a = state.captains[0];
  // empty=4 → reserve 1*3=3 → 100-5-3 = 92
  assert.equal(team.captainMaxBid(a), 92);
  assert.equal(team.isCaptainFull(a), false);
});

test('captainMaxBid after a purchase, and full at capacity', () => {
  setup({
    settings: { teamBudget: 100, teamSlots: 2, smallBlind: 1 },
    captains: [{ name: 'A', price: 5 }],
    players: [
      { name: 'P1', status: PLAYER_STATUS.SOLD, captainId: 1, price: 10 },
    ],
  });
  const a = state.captains[0];
  // drafted 1, empty 1, reserve 0, spent 15 → 100-15 = 85
  assert.equal(team.captainMaxBid(a), 85);
  assert.equal(team.isCaptainFull(a), false);
  // draft one more → full, max 0
  state.players.push({ id: 2, name: 'P2', role: '', status: PLAYER_STATUS.SOLD, captainId: 1, price: 20 });
  assert.equal(team.isCaptainFull(a), true);
  assert.equal(team.captainMaxBid(a), 0);
});

// ---------- outbid logic ----------

test('noOneCanOutbid: true only when every other captain is full or capped at/below', () => {
  setup({
    settings: { teamBudget: 100, teamSlots: 4, smallBlind: 1 },
    captains: [{ name: 'A', price: 0 }, { name: 'B', price: 0 }],
  });
  // B can clearly outbid a $5 bid
  assert.equal(sell.noOneCanOutbid(1, 5), false);
  // make B full → A's bid is uncontestable
  state.players.push(
    { id: 1, name: 'x1', role: '', status: PLAYER_STATUS.SOLD, captainId: 2, price: 1 },
    { id: 2, name: 'x2', role: '', status: PLAYER_STATUS.SOLD, captainId: 2, price: 1 },
    { id: 3, name: 'x3', role: '', status: PLAYER_STATUS.SOLD, captainId: 2, price: 1 },
    { id: 4, name: 'x4', role: '', status: PLAYER_STATUS.SOLD, captainId: 2, price: 1 },
  );
  assert.equal(sell.noOneCanOutbid(1, 5), true);
});

// ---------- full auction flow ----------

test('opening bid -> competing bid -> manual sell -> turn advances (waterfall)', () => {
  setup({
    settings: { teamBudget: 100, teamSlots: 2, smallBlind: 1, turnOrder: TURN_ORDER.WATERFALL },
    captains: [{ name: 'A' }, { name: 'B' }],
    players: [{ name: 'Faker', role: 'Mid' }, { name: 'Caps', role: 'Mid' }],
  });
  const [A, B] = state.captains;

  // start: advance from marker -1 -> first captain, OPENING
  turn.advanceTurn(); persistAll();
  assert.equal(state.settings.status, STATUS.OPENING);
  assert.equal(turn.currentTurnCaptain().id, A.id);

  // A opens on Faker for 5
  assert.deepEqual(bids.placeOpeningBid(A, 'Faker', 5), { ok: true });
  assert.equal(state.settings.status, STATUS.BIDDING);
  assert.equal(state.auction.highestBid, 5);
  assert.equal(state.auction.byCaptainId, A.id);

  // B outbids to 6
  assert.deepEqual(bids.placeBid(B, 6), { ok: true });
  assert.equal(state.auction.highestBid, 6);
  assert.equal(state.auction.byCaptainId, B.id);

  // admin sells (manual)
  const r = sell.finalizeSaleAndAdvance(); persistAll();
  assert.equal(r.ok, true);
  const faker = state.players.find((p) => p.name === 'Faker');
  assert.equal(faker.status, PLAYER_STATUS.SOLD);
  assert.equal(faker.captainId, B.id);
  assert.equal(faker.price, 6);
  // turn advanced to B, fresh OPENING, auction block cleared
  assert.equal(turn.currentTurnCaptain().id, B.id);
  assert.equal(state.settings.status, STATUS.OPENING);
  assert.equal(state.auction.currentPlayerId, null);
});

test('uncontestable opening bid auto-sells immediately when the other team is full', () => {
  setup({
    settings: { teamBudget: 100, teamSlots: 1, smallBlind: 1 },
    captains: [{ name: 'A' }, { name: 'B' }],
    players: [{ name: 'Solo', role: 'Top' }, { name: 'BPlayer', role: 'Top', status: PLAYER_STATUS.SOLD, captainId: 2, price: 1 }],
  });
  const [A] = state.captains;
  // B already has 1/1 -> full. A is the only one who can bid.
  turn.advanceTurn(); persistAll();
  assert.equal(turn.currentTurnCaptain().id, A.id);
  assert.deepEqual(bids.placeOpeningBid(A, 'Solo', 5), { ok: true });
  // Should have auto-sold + advanced (no one could outbid). A is now full -> all full -> FINISHED.
  const solo = state.players.find((p) => p.name === 'Solo');
  assert.equal(solo.status, PLAYER_STATUS.SOLD);
  assert.equal(solo.captainId, A.id);
  assert.equal(state.settings.status, STATUS.FINISHED);
});

test('a sale defers the next opening deadline by the sold-message duration', () => {
  setup({
    settings: { teamBudget: 100, teamSlots: 2, smallBlind: 1, openingTimeout: 30, soldMessageSeconds: 5 },
    captains: [{ name: 'A' }, { name: 'B' }],
    players: [{ name: 'P1', role: 'Mid' }, { name: 'P2', role: 'Mid' }],
  });
  const [A] = state.captains;
  turn.advanceTurn(); persistAll();                 // A opening
  assert.deepEqual(bids.placeOpeningBid(A, 'P1', 5), { ok: true });   // -> BIDDING

  const r = sell.finalizeSaleAndAdvance(); persistAll();
  assert.equal(r.ok, true);
  assert.equal(state.settings.status, STATUS.OPENING);               // advanced to B, OPENING
  // Reported opening time is clamped to the full timeout...
  assert.equal(turn.openingSecondsRemaining(), 30);
  // ...but the real deadline is parked ~soldMessageSeconds beyond it, so B's clock only truly
  // starts once the sold banner clears + B isn't auto-skipped during it.
  const rawRemaining = Math.round((state.clocks.openingDeadline - Date.now()) / 1000);
  assert.ok(rawRemaining > 30 && rawRemaining <= 36, 'deadline deferred by ~soldMessageSeconds: ' + rawRemaining);
  assert.equal(turn.autoSkipIfDeadlinePassed(), false);
});

test('skip advances; rejects when not your turn or not OPENING', () => {
  setup({
    settings: { teamSlots: 2, turnOrder: TURN_ORDER.WATERFALL },
    captains: [{ name: 'A' }, { name: 'B' }],
    players: [{ name: 'P1' }],
  });
  const [A, B] = state.captains;
  turn.advanceTurn(); persistAll();           // A's turn, OPENING
  assert.equal(bids.skipTurn(B).ok, false);   // not B's turn
  assert.equal(bids.skipTurn(A).ok, true);    // A skips
  assert.equal(turn.currentTurnCaptain().id, B.id);
});

test('opening bid snapshots a timed announcement (with the player image) that expires', () => {
  setup({
    settings: { teamBudget: 100, teamSlots: 2, smallBlind: 1, openingMessageSeconds: 5 },
    captains: [{ name: 'A' }, { name: 'B' }],
    players: [{ name: 'Faker', role: 'Mid' }, { name: 'Caps', role: 'Mid' }],
  });
  const [A] = state.captains;
  state.players.find((p) => p.name === 'Faker').image = 'pic.png';

  turn.advanceTurn(); persistAll();
  assert.equal(sell.recentOpeningMessage(), null);           // nothing before the bid

  assert.deepEqual(bids.placeOpeningBid(A, 'Faker', 5), { ok: true });
  assert.deepEqual(sell.recentOpeningMessage(), {
    player: 'Faker', bidder: 'A', bid: 5, image: '/uploads/pic.png',
  });

  state.clocks.lastOpening.at -= 6000;                       // window elapsed
  assert.equal(sell.recentOpeningMessage(), null);
});

test('opening bid defers the auto-sell window until the reveal ends', () => {
  setup({
    settings: { teamBudget: 100, teamSlots: 2, smallBlind: 1, sellMode: SELL_MODE.AUTO,
      autoWindow: 20, openingMessageSeconds: 5 },
    captains: [{ name: 'A' }, { name: 'B' }],   // contestable, so the opening won't auto-sell
    players: [{ name: 'Faker', role: 'Mid' }, { name: 'Caps', role: 'Mid' }],
  });
  const [A] = state.captains;
  turn.advanceTurn(); persistAll();

  const before = Date.now();
  assert.deepEqual(bids.placeOpeningBid(A, 'Faker', 5), { ok: true });

  // window start is parked ~openingMessageSeconds in the future...
  assert.ok(state.clocks.lastBidTime >= before + 5000 - 50, 'lastBidTime deferred into the future');
  // ...so the countdown reads full and can't auto-sell during the reveal
  assert.equal(sell.autoSellSecondsRemaining(), 20);
  assert.equal(sell.autoSellIfElapsed(), false);

  // reveal over, window just started: still full-ish, no sale yet
  state.clocks.lastBidTime = Date.now();
  assert.equal(sell.autoSellIfElapsed(), false);

  // full window elapsed after the reveal → auto-sells
  state.clocks.lastBidTime = Date.now() - 21000;
  assert.equal(sell.autoSellIfElapsed(), true);
});

test('auto-skip fires once the opening deadline passes', () => {
  setup({
    settings: { teamSlots: 2, openingTimeout: 30 },
    captains: [{ name: 'A' }, { name: 'B' }],
    players: [{ name: 'P1' }],
  });
  turn.advanceTurn(); persistAll();           // A, OPENING, deadline set
  assert.equal(turn.autoSkipIfDeadlinePassed(), false); // not yet
  state.clocks.openingDeadline = Date.now() - 1000;     // force expiry
  assert.equal(turn.autoSkipIfDeadlinePassed(), true);
  assert.equal(turn.currentTurnCaptain().id, state.captains[1].id);
});
