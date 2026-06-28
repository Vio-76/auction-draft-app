/**
 * The server's heartbeat. Replaces the old "piggyback on getState" auto-skip / auto-sell
 * (which only ran when a captain happened to poll). Once a second it:
 *   - auto-skips the turn-holder if the opening deadline passed,
 *   - auto-sells in AUTO mode if the no-new-bid window elapsed,
 *   - otherwise, while something time-based is live (an opening countdown, an AUTO window,
 *     or a showing sold banner), re-pushes so clients' time-derived UI stays fresh
 *     (e.g. the sold banner disappears on time).
 */

const { state, persistAll } = require('./state');
const { STATUS } = require('./config');
const { markChanged } = require('./bus');
const turn = require('./logic/turn');
const sell = require('./logic/sell');

let interval = null;

function tick() {
  let changed = false;
  if (turn.autoSkipIfDeadlinePassed()) changed = true;
  if (sell.autoSellIfElapsed()) changed = true;

  if (changed) {
    persistAll();
    markChanged();
    return;
  }

  const s = state.settings;
  const live = s.status === STATUS.OPENING || s.status === STATUS.BIDDING || !!sell.recentSoldMessage();
  if (live) markChanged(); // no state change — just re-push time-derived fields
}

function start() {
  if (interval) return;
  interval = setInterval(tick, 1000);
}

function stop() {
  if (interval) { clearInterval(interval); interval = null; }
}

module.exports = { start, stop, tick };
