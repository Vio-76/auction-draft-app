'use strict';
// Isolated in-memory DB before anything requires db.js.
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');

const { state, load, persistAll, migrateTierRanges } = require('../server/state');
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

test('captainMaxBid is the remaining budget (no reserve for other empty slots)', () => {
  setup({
    settings: { teamBudget: 100, teamSlots: 4, smallBlind: 1 },
    captains: [{ name: 'A', price: 5 }],
  });
  const a = state.captains[0];
  // 100 − captain price 5 = 95 (the old rule also held back 1 × 3 other empty slots)
  assert.equal(team.captainMaxBid(a), 95);
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
    players: [{ name: 'OnTheBlock' }],   // something left in the pool, so nobody is broke
  });
  // B can clearly outbid a $5 bid
  assert.equal(sell.noOneCanOutbid(1, 5), false);
  // make B full → A's bid is uncontestable
  state.players.push(
    { id: 11, name: 'x1', role: '', status: PLAYER_STATUS.SOLD, captainId: 2, price: 1 },
    { id: 12, name: 'x2', role: '', status: PLAYER_STATUS.SOLD, captainId: 2, price: 1 },
    { id: 13, name: 'x3', role: '', status: PLAYER_STATUS.SOLD, captainId: 2, price: 1 },
    { id: 14, name: 'x4', role: '', status: PLAYER_STATUS.SOLD, captainId: 2, price: 1 },
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

// ---------- tiers ----------

const admin = require('../server/adminActions');

test('opening bid uses the player tier minimum; untiered players use the default', () => {
  setup({
    settings: { teamBudget: 100, teamSlots: 2, smallBlind: 2 },
    captains: [{ name: 'A' }, { name: 'B' }],
    players: [{ name: 'Faker', role: 'Mid' }, { name: 'Caps', role: 'Mid' }],
  });
  assert.equal(admin.setTiers([{ name: 'S-Tier', minBid: 30 }]).ok, true);
  const sId = state.settings.tiers[0].id;
  state.players.find((p) => p.name === 'Faker').tierId = sId;
  const [A] = state.captains;
  turn.advanceTurn(); persistAll();

  const low = bids.placeOpeningBid(A, 'Faker', 29);
  assert.equal(low.ok, false);
  assert.match(low.error, /at least \$30 \(S-Tier\)/);
  assert.equal(state.settings.status, STATUS.OPENING);        // rejected bid changed nothing

  assert.equal(bids.placeOpeningBid(A, 'Caps', 1).ok, false);  // untiered: default min $2
  assert.deepEqual(bids.placeOpeningBid(A, 'Faker', 30), { ok: true });
});

test('untiered players are priced like the lowest tier (by min bid); default min only without tiers', () => {
  setup({ settings: { smallBlind: 5 }, players: [{ name: 'P1' }] });
  assert.equal(team.playerMinBid(state.players[0]), 5);          // no tiers → default min bid
  admin.setTiers([{ name: 'S-Tier', minBid: 30 }, { name: 'Gold', minBid: 1 }, { name: 'B-Tier', minBid: 10 }]);
  assert.equal(team.lowestTier().name, 'Gold');                  // lowest = smallest min, not card order
  assert.equal(team.playerMinBid(state.players[0]), 1);          // untiered → Gold's $1
});

test('setTiers keeps ids across rename/reorder, untiers players of removed tiers, validates', () => {
  setup({ players: [{ name: 'P1' }, { name: 'P2' }] });
  admin.setTiers([{ name: 'S', minBid: 30 }, { name: 'A', minBid: 15 }]);
  const [s, a] = state.settings.tiers;
  state.players[0].tierId = s.id;
  state.players[1].tierId = a.id;

  // rename + reorder + re-price S, drop A, add B
  assert.equal(admin.setTiers([
    { id: 999, name: 'B', minBid: 5 },
    { id: s.id, name: 'S-Tier', minBid: 40 },
  ]).ok, true);
  const tiers = state.settings.tiers;
  assert.deepEqual(tiers.map((t) => t.name), ['B', 'S-Tier']);
  assert.equal(tiers[1].id, s.id);                              // kept
  assert.notEqual(tiers[0].id, a.id);                           // unknown id 999 → fresh id, not reused
  assert.notEqual(tiers[0].id, 999);
  assert.equal(team.playerMinBid(state.players[0]), 40);
  assert.equal(state.players[1].tierId, null);                  // A removed → untiered

  assert.equal(admin.setTiers([{ name: 'X', minBid: 1 }, { name: 'x', minBid: 2 }]).ok, false);  // dup (case-insensitive)
  assert.equal(admin.setTiers([{ name: '', minBid: 1 }]).ok, false);
  assert.equal(admin.setTiers([{ name: 'X', minBid: -1 }]).ok, false);
  assert.equal(admin.setTiers([{ name: 'X', minBid: 1.5 }]).ok, false);
  assert.equal(admin.setTiers([{ name: 'A,B', minBid: 1 }]).ok, false);
  assert.deepEqual(state.settings.tiers.map((t) => t.name), ['B', 'S-Tier']);   // failed saves change nothing
});

test('tier price range: optional floor + ceiling, whole numbers, ceiling not below the floor', () => {
  setup({});
  assert.equal(admin.setTiers([
    { name: 'Master', minBid: 15, rangeMin: 20, rangeMax: 30 },
    { name: 'Gold', minBid: 5, rangeMin: '', rangeMax: 14 },
    { name: 'Iron', minBid: 1 },
  ]).ok, true);
  assert.deepEqual(state.settings.tiers.map((t) => [t.rangeMin, t.rangeMax]), [[20, 30], [null, 14], [null, null]]);
  assert.match(admin.setTiers([{ name: 'Master', minBid: 15, rangeMin: 30, rangeMax: 20 }]).error, /can't be below the floor/);
  assert.equal(admin.setTiers([{ name: 'Master', minBid: 15, rangeMax: 2.5 }]).ok, false);
  assert.equal(admin.setTiers([{ name: 'Master', minBid: 15, rangeMin: -1 }]).ok, false);
  assert.equal(state.settings.tiers[0].rangeMax, 30);            // failed saves changed nothing
  assert.equal(admin.setTiers([{ name: 'Master', minBid: 15, rangeMin: 25, rangeMax: 25 }]).ok, true);   // floor = ceiling is fine
});

test('old free-text tier ranges are converted to floor / ceiling numbers on load', () => {
  setup({});
  state.settings.tiers = [
    { id: 1, name: 'A', minBid: 1, range: '25-30$' },
    { id: 2, name: 'B', minBid: 1, range: '$30 - 20' },
    { id: 3, name: 'C', minBid: 1, range: '15+' },
    { id: 4, name: 'D', minBid: 1, range: 'max 12$' },
    { id: 5, name: 'E', minBid: 1, range: 'cheap' },
    { id: 6, name: 'F', minBid: 1, range: '9-99', rangeMin: 1, rangeMax: 2 },   // already converted: untouched
  ];
  migrateTierRanges();
  assert.deepEqual(state.settings.tiers.map((t) => [t.rangeMin, t.rangeMax]),
    [[25, 30], [20, 30], [15, null], [null, 12], [null, null], [1, 2]]);
});

test('bids above the tier price ceiling are flagged (live bid + sold banner), never blocked', () => {
  setup({ settings: { teamBudget: 100, teamSlots: 2, sellMode: SELL_MODE.MANUAL },
    captains: [{ name: 'A', price: 0 }, { name: 'B', price: 0 }],
    players: [{ name: 'Star' }, { name: 'Free' }, { name: 'Other' }] });
  admin.setTiers([{ name: 'Master', minBid: 5, rangeMin: 20, rangeMax: 30 }]);
  const tierId = state.settings.tiers[0].id;
  const star = state.players.find((p) => p.name === 'Star');
  star.tierId = tierId;
  assert.equal(team.priceCeiling(star), 30);
  assert.equal(team.isAboveCeiling(star, 30), false);              // exactly the ceiling is fine
  assert.equal(team.isAboveCeiling(star, 31), true);
  const free = state.players.find((p) => p.name === 'Free');
  assert.equal(team.priceCeiling(free), null);                      // untiered → no ceiling
  assert.equal(team.isAboveCeiling(free, 999), false);

  const [A, B] = state.captains;
  turn.advanceTurn();
  assert.equal(bids.placeOpeningBid(A, 'Star', 25).ok, true);
  assert.equal(bids.placeBid(B, 40).ok, true);                      // above the ceiling: still allowed
  assert.equal(sell.sellPlayerInner().ok, true);
  assert.equal(sell.recentSoldMessage().over, true);
});

test('import matches the Tier column by name and reports unknown tiers', () => {
  setup({});
  admin.setTiers([{ name: 'S-Tier', minBid: 30 }]);
  const sId = state.settings.tiers[0].id;
  const res = admin.importPlayers('Faker\tMid\tfaker_gg\ts-tier\nZeus,Top,,Z-Tier\nCaps,Mid', 'replace');
  assert.equal(res.ok, true);
  assert.equal(res.added, 3);
  assert.deepEqual(res.unknownTiers, ['Z-Tier']);
  const by = (n) => state.players.find((p) => p.name === n);
  assert.equal(by('Faker').tierId, sId);
  assert.equal(by('Faker').discord, 'faker_gg');
  assert.equal(by('Zeus').tierId, null);
  assert.equal(by('Zeus').discord, '');
  assert.equal(by('Caps').tierId, null);
});

// ---------- unique names ----------

test('captain names must be unique (add, rename, import)', () => {
  setup({ captains: [{ name: 'Monarch' }, { name: 'Tomi' }] });
  assert.equal(admin.addCaptain({ name: ' monarch ' }).ok, false);      // trimmed + case-insensitive
  assert.equal(admin.updateCaptain(2, { name: 'MONARCH' }).ok, false);
  assert.equal(state.captains[1].name, 'Tomi');                         // rejected rename changed nothing
  assert.equal(admin.updateCaptain(1, { name: 'monarch' }).ok, true);   // re-casing your own name is fine

  assert.equal(admin.importCaptains('Vex\nTomi', 'append').ok, false);  // clashes with existing
  assert.equal(admin.importCaptains('Vex\nvex', 'replace').ok, false);  // repeats within the paste
  assert.equal(state.captains.length, 2);                               // failed imports changed nothing
  assert.equal(admin.importCaptains('Tomi\nVex', 'replace').ok, true);  // replace: old names don't count
});

test('player names must be unique (add, rename, import)', () => {
  setup({
    captains: [{ name: 'A' }],
    players: [{ name: 'Faker' }, { name: 'Caps' }, { name: 'Zeus', status: PLAYER_STATUS.SOLD, captainId: 1, price: 5 }],
  });
  assert.equal(admin.addPlayer({ name: 'faker' }).ok, false);
  assert.equal(admin.updatePlayer(2, { name: 'Faker' }).ok, false);
  assert.equal(admin.updatePlayer(2, { name: 'caps' }).ok, true);

  assert.equal(admin.importPlayers('Chovy\nCaps', 'append').ok, false);
  assert.equal(admin.importPlayers('Chovy\nzeus', 'replace').ok, false);  // drafted players are kept → still clash
  assert.equal(state.players.length, 3);
  assert.equal(admin.importPlayers('Faker\nChovy', 'replace').ok, true);  // open pool is replaced → no clash
});

// ---------- broke captains (#7) ----------

test('broke: $0 left, or below the cheapest min still in the pool; full teams are never broke', () => {
  setup({
    settings: { teamBudget: 30, teamSlots: 3 },
    captains: [{ name: 'Rich' }, { name: 'Spent', price: 30 }, { name: 'Low', price: 25 }],
    players: [{ name: 'Base' }, { name: 'Pricey' }],
  });
  admin.setTiers([{ name: 'Gold', minBid: 1 }, { name: 'S', minBid: 8 }]);
  const [gold, sTier] = state.settings.tiers;
  state.players[0].tierId = gold.id;
  state.players[1].tierId = sTier.id;
  const [rich, spent, low] = state.captains;

  assert.equal(team.isCaptainBroke(rich), false);
  assert.equal(team.isCaptainBroke(spent), true);                // $0 left
  assert.equal(team.isCaptainBroke(low), false);                 // $5 left, a $1 base player remains

  state.players[0].status = PLAYER_STATUS.SOLD;                  // base tier empties → cheapest is $8
  state.players[0].captainId = 1;
  assert.equal(team.isCaptainBroke(low), true);                  // $5 < $8
  assert.equal(team.isCaptainBroke(rich), false);

  state.settings.teamSlots = 0;                                  // everyone full → nobody broke
  assert.equal(team.isCaptainBroke(spent), false);
});

test('broke order: same action → same brokeSeq, later → higher; tie roll kept; recovering clears it', () => {
  setup({
    settings: { teamBudget: 10, teamSlots: 3 },
    captains: [{ name: 'A', price: 10 }, { name: 'B', price: 10 }, { name: 'C', price: 2 }],
    players: [{ name: 'P' }],
  });
  const [A, B, C] = state.captains;
  team.updateBrokeState();
  assert.equal(A.brokeSeq, 1);
  assert.equal(B.brokeSeq, 1);                                   // same moment
  assert.equal(C.brokeSeq || 0, 0);
  const tie = A.brokeTie;

  C.price = 10;                                                  // C goes broke later
  team.updateBrokeState();
  assert.equal(C.brokeSeq, 2);
  assert.equal(A.brokeTie, tie);                                 // not re-rolled

  A.price = 0;                                                   // admin edit: A can afford again
  team.updateBrokeState();
  assert.equal(A.brokeSeq, 0);
});

test('broke captains are skipped in the turn order and cannot open or bid', () => {
  setup({
    settings: { teamBudget: 10, teamSlots: 2, smallBlind: 1, turnOrder: TURN_ORDER.WATERFALL },
    captains: [{ name: 'A' }, { name: 'Broke', price: 10 }, { name: 'C' }],
    players: [{ name: 'P1' }, { name: 'P2' }],
  });
  const [A, broke, C] = state.captains;
  turn.advanceTurn(); persistAll();
  assert.equal(turn.currentTurnCaptain().id, A.id);
  assert.equal(bids.skipTurn(A).ok, true);
  assert.equal(turn.currentTurnCaptain().id, C.id);              // Broke was skipped

  assert.equal(bids.placeOpeningBid(C, 'P1', 3).ok, true);
  const r = bids.placeBid(broke, 4);
  assert.equal(r.ok, false);
  assert.match(r.error, /You're broke/);
});

// ---------- fill-up round (#7) ----------

const fillup = require('../server/logic/fillup');
const sellMod = require('../server/logic/sell');

/** Tiers Gold ($1, base) < Silver ($5) < Master ($20); returns their ids. */
function threeTiers() {
  admin.setTiers([{ name: 'Master', minBid: 20 }, { name: 'Gold', minBid: 1 }, { name: 'Silver', minBid: 5 }]);
  const by = (n) => state.settings.tiers.find((t) => t.name === n).id;
  return { gold: by('Gold'), silver: by('Silver'), master: by('Master') };
}

test('fill-up order: later broke first; same moment → more budget, fewer slots, cheaper captain, random', () => {
  setup({ settings: { teamBudget: 20, teamSlots: 3 }, captains: [
    { name: 'Early', price: 20 }, { name: 'RichTie', price: 10 }, { name: 'PoorTie', price: 15 },
    { name: 'Late', price: 20 }, { name: 'SlotsTie', price: 10 } ] });
  const [early, richTie, poorTie, late, slotsTie] = state.captains;
  early.brokeSeq = 1; late.brokeSeq = 3;
  for (const c of [richTie, poorTie, slotsTie]) c.brokeSeq = 2;           // went broke together
  // SlotsTie has the same $10 left as RichTie but one more player drafted → fewer open slots
  state.players.push({ id: 50, name: 'x', role: '', status: PLAYER_STATUS.SOLD, captainId: slotsTie.id, price: 0 });
  const order = [early, richTie, poorTie, late, slotsTie].sort(fillup.compareFillOrder).map((c) => c.name);
  assert.deepEqual(order, ['Late', 'SlotsTie', 'RichTie', 'PoorTie', 'Early']);
});

test('fill-up quotas: base tier first, the shortfall comes from the next tier up, then the next', () => {
  setup({ settings: { teamBudget: 10, teamSlots: 4 }, captains: [{ name: 'A', price: 10 }, { name: 'B', price: 10 }],
    players: [{ name: 'g1' }, { name: 's1' }, { name: 's2' }, { name: 'm1' }, { name: 'm2' }, { name: 'm3' }, { name: 'free' }] });
  const t = threeTiers();
  const tier = (n, id) => { state.players.find((p) => p.name === n).tierId = id; };
  tier('g1', t.gold); tier('s1', t.silver); tier('s2', t.silver); tier('m1', t.master); tier('m2', t.master); tier('m3', t.master);
  // 8 open slots; base = g1 + 'free' (untiered) = 2 → 6 extra: Silver 2 (all it has), Master 3 (all), 1 uncovered
  assert.deepEqual(fillup.computeQuotas(8), { [t.silver]: 2, [t.master]: 3 });
  // 2 open slots ≤ 2 base players → nothing from higher tiers
  assert.deepEqual(fillup.computeQuotas(2), { [t.silver]: 0, [t.master]: 0 });
});

test('fill-up round: starts when only broke captains are left, picks in stack order, uses quotas, finishes', () => {
  setup({ settings: { teamBudget: 10, teamSlots: 2, turnOrder: TURN_ORDER.WATERFALL, soldMessageSeconds: 5 },
    captains: [{ name: 'A', price: 10 }, { name: 'B', price: 10 }],
    players: [{ name: 'Gold1' }, { name: 'Silver1' }, { name: 'Silver2' }, { name: 'Silver3' }, { name: 'Master1' }] });
  const t = threeTiers();
  const tier = (n, id) => { state.players.find((p) => p.name === n).tierId = id; };
  tier('Gold1', t.gold); tier('Silver1', t.silver); tier('Silver2', t.silver); tier('Silver3', t.silver); tier('Master1', t.master);
  const [A, B] = state.captains;
  A.brokeSeq = 1; B.brokeSeq = 2;                                    // B went broke later → picks first

  turn.advanceTurn();                                               // nobody can open → fill-up
  assert.equal(state.settings.status, STATUS.FILLUP);
  assert.deepEqual(state.settings.fillOrder, [B.id, A.id]);
  assert.deepEqual(state.settings.fillQuota, { [t.silver]: 3, [t.master]: 0 });   // 4 slots − 1 base

  assert.equal(bids.fillPick(A, 'Gold1').ok, false);                // not A's pick
  assert.match(bids.fillPick(B, 'Master1').error, /No picks left from Master/);
  assert.equal(bids.fillPick(B, 'Silver1').ok, true);
  assert.equal(state.players.find((p) => p.name === 'Silver1').price, 0);
  assert.equal(state.settings.fillQuota[t.silver], 2);
  assert.equal(sellMod.recentSoldMessage().kind, 'pick');
  assert.equal(bids.fillPick(B, 'Silver2').ok, true);               // B full → off the stack
  assert.deepEqual(state.settings.fillOrder, [A.id]);
  assert.deepEqual(state.settings.fillDone, [B.id]);

  assert.equal(bids.fillPick(A, 'Gold1').ok, true);
  assert.equal(bids.fillPick(A, 'Silver3').ok, true);               // last quota pick
  assert.equal(state.settings.status, STATUS.FINISHED);              // stack empty → done
});

test('fill-up round: admin assign counts against the quota; admin can reorder the stack; ends if nothing pickable', () => {
  setup({ settings: { teamBudget: 10, teamSlots: 2 },
    captains: [{ name: 'A', price: 10 }, { name: 'B', price: 10 }, { name: 'C', price: 10 }],
    players: [{ name: 'Gold1' }, { name: 'Silver1' }, { name: 'Master1' }] });
  const t = threeTiers();
  const tier = (n, id) => { state.players.find((p) => p.name === n).tierId = id; };
  tier('Gold1', t.gold); tier('Silver1', t.silver); tier('Master1', t.master);
  const [A, B, C] = state.captains;
  A.brokeSeq = 1; B.brokeSeq = 2; C.brokeSeq = 3;
  fillup.start();
  assert.deepEqual(state.settings.fillOrder, [C.id, B.id, A.id]);
  // 6 slots, 1 base → 5 extra: Silver 1, Master 1
  assert.deepEqual(state.settings.fillQuota, { [t.silver]: 1, [t.master]: 1 });

  assert.equal(admin.moveFillUp(A.id, 'up').ok, true);
  assert.deepEqual(state.settings.fillOrder, [C.id, A.id, B.id]);

  assert.equal(admin.assignPlayerToTeam(3, C.id, 0).ok, true);       // admin picks Master1 for C
  assert.equal(state.settings.fillQuota[t.master], 0);
  assert.equal(admin.assignPlayerToTeam(2, C.id, 0).ok, true);       // and Silver1 → C full
  assert.deepEqual(state.settings.fillOrder, [A.id, B.id]);
  assert.equal(state.settings.status, STATUS.FILLUP);

  assert.equal(bids.fillPick(A, 'Gold1').ok, true);                 // last pickable player taken
  assert.equal(state.settings.status, STATUS.FINISHED);              // nothing left → finished with empty slots
});

test('fill-up round: quotas are live — a higher-tier pick lowers its quota, unassigning it gives the pick back', () => {
  setup({ settings: { teamBudget: 10, teamSlots: 3 },
    captains: [{ name: 'A', price: 10 }, { name: 'B', price: 10 }],
    players: [{ name: 'Gold1' }, { name: 'Silver1' }, { name: 'Silver2' }, { name: 'Master1' }, { name: 'Master2' }] });
  const t = threeTiers();
  const tier = (n, id) => { state.players.find((p) => p.name === n).tierId = id; };
  tier('Gold1', t.gold); tier('Silver1', t.silver); tier('Silver2', t.silver); tier('Master1', t.master); tier('Master2', t.master);
  const [A, B] = state.captains;
  A.brokeSeq = 1; B.brokeSeq = 2;
  fillup.start();
  const before = { ...state.settings.fillQuota };
  const top = state.captains.find((c) => c.id === state.settings.fillOrder[0]);
  const id = (n) => state.players.find((p) => p.name === n).id;

  assert.equal(bids.fillPick(top, 'Silver1').ok, true);              // uses a Silver pick
  assert.equal(state.settings.fillQuota[t.silver], before[t.silver] - 1);
  assert.equal(bids.fillPick(top, 'Gold1').ok, true);                // base pick, no quota
  assert.equal(admin.removePlayerFromTeam(id('Silver1')).ok, true);  // admin unassigns the Silver pick
  assert.equal(state.settings.fillQuota[t.silver], before[t.silver]); // ...and the pick is back
  assert.equal(admin.removePlayerFromTeam(id('Silver1')).ok, true);  // unassigning again changes nothing
  assert.equal(state.settings.fillQuota[t.silver], before[t.silver]);
  assert.equal(admin.removePlayerFromTeam(id('Gold1')).ok, true);    // base pick: quotas unchanged
  assert.deepEqual(state.settings.fillQuota, before);
});

test('fill-up round: pause keeps the round; phase buttons / Empty teams refused; resume picks up where it was', () => {
  setup({ settings: { teamBudget: 10, teamSlots: 2 },
    captains: [{ name: 'A', price: 10 }, { name: 'B', price: 10 }],
    players: [{ name: 'Gold1' }, { name: 'Gold2' }, { name: 'Silver1' }, { name: 'Master1' }] });
  const t = threeTiers();
  const tier = (n, id) => { state.players.find((p) => p.name === n).tierId = id; };
  tier('Gold1', t.gold); tier('Gold2', t.gold); tier('Silver1', t.silver); tier('Master1', t.master);
  const [A, B] = state.captains;
  A.brokeSeq = 1; B.brokeSeq = 2;
  fillup.start();
  assert.equal(admin.moveFillUp(A.id, 'up').ok, true);               // admin reorder: A on top
  assert.equal(bids.fillPick(A, 'Gold1').ok, true);
  const quota = { ...state.settings.fillQuota };

  assert.equal(admin.closeBidding().ok, true);                       // Pause
  assert.equal(state.settings.status, STATUS.CLOSED);
  assert.equal(state.settings.fillPaused, true);
  assert.deepEqual(state.settings.fillOrder, [A.id, B.id]);           // order (incl. the reorder) kept
  assert.deepEqual(state.settings.fillQuota, quota);
  assert.equal(bids.fillPick(A, 'Gold2').ok, false);                 // no picking while paused
  for (const r of [admin.openOpeningBid(), admin.openBidding(), admin.emptyTeams(), admin.skipTurn(),
    admin.setStatus(STATUS.OPENING), admin.setStatus(STATUS.BIDDING)]) assert.equal(r.ok, false);
  assert.equal(state.settings.status, STATUS.CLOSED);
  assert.equal(admin.moveFillUp(B.id, 'up').ok, true);               // reorder still allowed while paused
  assert.deepEqual(state.settings.fillOrder, [B.id, A.id]);

  assert.equal(admin.resumeFillup().ok, true);                       // Resume fill-up
  assert.equal(state.settings.status, STATUS.FILLUP);
  assert.equal(state.settings.fillPaused, false);
  assert.deepEqual(state.settings.fillOrder, [B.id, A.id]);
  assert.equal(bids.fillPick(B, 'Gold2').ok, true);
  assert.equal(admin.resumeFillup().ok, false);                      // nothing paused any more

  admin.closeBidding();                                              // Set Finished ends a paused round
  assert.equal(admin.setStatus(STATUS.FINISHED).ok, true);
  assert.equal(state.settings.fillPaused, false);
  assert.equal(admin.openOpeningBid().ok, true);                     // phase buttons work again afterwards
});

// ---------- co-captains ----------

test('co-captain: own price counts, listed first, one per team, survives Empty teams, cleared on unassign', () => {
  setup({
    settings: { teamBudget: 100, teamSlots: 4, smallBlind: 1 },
    captains: [{ name: 'A', price: 6 }, { name: 'B' }],
    players: [{ name: 'Bought', status: PLAYER_STATUS.SOLD, captainId: 1, price: 20 }, { name: 'Tomi' }, { name: 'Other' }],
  });
  state.players[0].soldSeq = 1;
  const A = state.captains[0];

  assert.equal(admin.assignPlayerToTeam(2, 1, 4, true).ok, true);         // Tomi = A's co-captain at $4
  const tomi = state.players[1];
  assert.equal(tomi.coCaptain, true);
  // remaining budget: 100 − (6 + 20 + 4) = 70
  assert.equal(team.captainMaxBid(A), 70);
  assert.deepEqual(require('../server/state').draftedPlayers(1).map((p) => p.name), ['Tomi', 'Bought']);   // co-captain first
  const t0 = require('../server/payload').buildBoardState().teams[0];
  assert.deepEqual(t0.players.slice(0, 2).map((p) => [p.name, p.price, p.coCaptain]), [['Tomi', 4, true], ['Bought', 20, false]]);

  const second = admin.assignPlayerToTeam(3, 1, 1, true);                 // A already has one
  assert.equal(second.ok, false);
  assert.match(second.error, /already has a co-captain/);

  assert.equal(admin.emptyTeams().ok, true);                               // bought player returns, co-captain stays
  assert.equal(state.players[0].status, PLAYER_STATUS.OPEN);
  assert.deepEqual([tomi.status, tomi.captainId, tomi.price, tomi.coCaptain], [PLAYER_STATUS.SOLD, 1, 4, true]);

  assert.equal(admin.removePlayerFromTeam(2).ok, true);                    // unassign clears the flag
  assert.deepEqual([tomi.status, tomi.coCaptain], [PLAYER_STATUS.OPEN, false]);
});

// ---------- team identity on the board ----------

const payload = require('../server/payload');

test('board team name/logo: hidden during the auction unless enabled; name can be hidden; group stays FINISHED-only', () => {
  setup({ captains: [{ name: 'A' }] });
  Object.assign(state.captains[0], { teamName: 'Royal Guard', logo: 'c1-abcd.png', teamGroup: 'A' });
  const team0 = () => payload.buildBoardState().teams[0];

  state.settings.status = STATUS.BIDDING;                       // default: only once FINISHED
  assert.deepEqual([team0().teamName, team0().teamLogo, team0().teamGroup], ['', '', '']);

  assert.equal(admin.updateSettings({ teamIdentityAlways: true }).ok, true);
  state.settings.status = STATUS.BIDDING;
  assert.deepEqual([team0().teamName, team0().teamLogo, team0().teamGroup], ['Royal Guard', '/uploads/c1-abcd.png', '']);

  assert.equal(admin.updateSettings({ showTeamNameOnBoard: false }).ok, true);   // logo only
  state.settings.status = STATUS.BIDDING;
  assert.deepEqual([team0().teamName, team0().teamLogo], ['', '/uploads/c1-abcd.png']);

  admin.updateSettings({ teamIdentityAlways: false, showTeamNameOnBoard: true });
  state.settings.status = STATUS.FINISHED;                      // finished: everything shows
  assert.deepEqual([team0().teamName, team0().teamLogo, team0().teamGroup], ['Royal Guard', '/uploads/c1-abcd.png', 'A']);
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
