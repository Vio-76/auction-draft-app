/**
 * Turn rotation: the marker (an index into the seat-ordered captains), waterfall/snake
 * order + direction, the opening-bid deadline, and advance/skip. Mutates state only;
 * the caller persists + notifies.
 *
 * Ported from TurnHelpers.js. The marker that was a sheet cell is now state.settings.marker;
 * snake direction is state.settings.turnDirection (+1 DOWN / -1 UP).
 */

const { state, captainsBySeat } = require('../state');
const { STATUS, TURN_ORDER, TURN_DIR } = require('../config');
const team = require('./team');

// ----- pure index walkers (ported verbatim, predicate instead of a name map) -----

/** Next non-full index, wrapping. -1 if all full. */
function findNextAvailableIndex(currentIdx, caps, isFull) {
  const n = caps.length;
  if (n === 0) return -1;
  const startFrom = currentIdx === -1 ? -1 : currentIdx;
  for (let step = 1; step <= n; step++) {
    const idx = (startFrom + step + n) % n;
    if (!isFull(caps[idx])) return idx;
  }
  return -1;
}

/** Next non-full index in SNAKE order + resulting direction. Bounces at the ends with the
 *  end captain repeating (true back-to-back snake); skips full captains. */
function findNextSnakeIndex(currentIdx, direction, caps, isFull) {
  const n = caps.length;
  if (n === 0) return { idx: -1, direction: TURN_DIR.DOWN };
  if (currentIdx === -1) {
    for (let i = 0; i < n; i++) if (!isFull(caps[i])) return { idx: i, direction: TURN_DIR.DOWN };
    return { idx: -1, direction: TURN_DIR.DOWN };
  }
  let dir = direction;
  let idx = currentIdx;
  for (let guard = 0; guard < 4 * n; guard++) {     // guard against an all-full loop
    let nxt = idx + dir;
    if (nxt < 0 || nxt >= n) { dir = -dir; nxt = idx; }   // bounce: same end goes again
    idx = nxt;
    if (!isFull(caps[idx])) return { idx, direction: dir };
  }
  return { idx: -1, direction: dir };
}

// ----- marker -----

function currentTurnCaptain() {
  const caps = captainsBySeat();
  const idx = state.settings.marker;
  if (idx < 0 || idx >= caps.length) return null;
  return caps[idx];
}

// ----- opening-bid deadline (ephemeral) -----

function setOpeningDeadline() {
  state.clocks.openingDeadline = Date.now() + state.settings.openingTimeout * 1000;
}
function clearOpeningDeadline() {
  state.clocks.openingDeadline = 0;
}
function openingSecondsRemaining() {
  if (!state.clocks.openingDeadline) return state.settings.openingTimeout;
  return Math.max(0, Math.round((state.clocks.openingDeadline - Date.now()) / 1000));
}

// ----- advance / skip (state only) -----

/**
 * Move the marker to the next eligible captain (waterfall/snake order, skipping full teams),
 * updating the snake direction. Marker ONLY — does not touch status or the opening deadline.
 * Returns the new index (-1 if none eligible).
 */
function advanceMarker() {
  const caps = captainsBySeat();
  const isFull = (c) => team.isCaptainFull(c);

  let nextIdx;
  if (state.settings.turnOrder === TURN_ORDER.SNAKE) {
    const step = findNextSnakeIndex(state.settings.marker, state.settings.turnDirection, caps, isFull);
    nextIdx = step.idx;
    state.settings.turnDirection = step.direction;
  } else {
    nextIdx = findNextAvailableIndex(state.settings.marker, caps, isFull);
  }
  state.settings.marker = nextIdx;
  return nextIdx;
}

/** Advance the marker AND move the phase into OPENING (or FINISHED if all full). Used by the
 *  normal flow (after a sale, on start, on opening-deadline auto-skip). */
function advanceTurn() {
  const nextIdx = advanceMarker();
  if (nextIdx !== -1) {
    state.settings.status = STATUS.OPENING;
    setOpeningDeadline();
  } else {
    state.settings.status = STATUS.FINISHED;
    clearOpeningDeadline();
  }
}

/**
 * Full skip: advance the turn AND the phase. In SNAKE mode the end captain gets two
 * back-to-back turns at a turnaround — skipping the first should skip both, so if the advance
 * lands back on the same captain (the bounce), advance once more. (Captain skip + auto-skip.)
 */
function skipTurnAdvance() {
  const skipped = currentTurnCaptain();
  advanceTurn();
  const now = currentTurnCaptain();
  if (skipped && now && now.id === skipped.id) advanceTurn();
}

/**
 * Marker-only skip for the admin "Skip Turn": moves the marker to the next captain (with the
 * same SNAKE double-turn handling) but does NOT change the auction status, the opening
 * deadline, or the in-flight bid. Usable in any phase.
 */
function skipMarker() {
  const skipped = currentTurnCaptain();
  advanceMarker();
  const now = currentTurnCaptain();
  if (skipped && now && now.id === skipped.id) advanceMarker();
}

/** Returns true if it auto-skipped (so the caller can persist + broadcast). */
function autoSkipIfDeadlinePassed() {
  if (state.settings.status !== STATUS.OPENING) return false;
  if (!state.clocks.openingDeadline) return false;
  if (Date.now() < state.clocks.openingDeadline) return false;
  skipTurnAdvance();
  return true;
}

module.exports = {
  findNextAvailableIndex,
  findNextSnakeIndex,
  currentTurnCaptain,
  setOpeningDeadline,
  clearOpeningDeadline,
  openingSecondsRemaining,
  advanceMarker,
  advanceTurn,
  skipTurnAdvance,
  skipMarker,
  autoSkipIfDeadlinePassed,
};
