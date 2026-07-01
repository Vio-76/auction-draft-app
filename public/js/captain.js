/* Captain page client. Ported from Index.html. State arrives over the WebSocket
   (connectState) instead of 1s polling of getState; actions go over fetch POST
   (postJson) instead of google.script.run, but return the same { ok, error } shape so
   the rest of the logic is unchanged. esc()/toggleInfo()/connectState()/postJson() come
   from shared.js. captain/OPENING_TIMEOUT are injected by captain.ejs. Auth is a session
   cookie set when the invite link was opened, so no secret travels in the URL or requests. */

const captain = window.CAPTAIN;
const OPENING_TIMEOUT = window.OPENING_TIMEOUT;

const STATUSES = { OPENING: 'OPENING', BIDDING: 'BIDDING', CLOSED: 'CLOSED', FINISHED: 'FINISHED' };
const SELL_MODE_AUTO = 'AUTO';

let lastKey = '';
let submitting = false;

const TIMER_R = 26;
const TIMER_C = 2 * Math.PI * TIMER_R;

const _themeCss = getComputedStyle(document.body);
const RING = (_themeCss.getPropertyValue('--accent').trim()) || '#f6b53c';
const RING_URGENT = (_themeCss.getPropertyValue('--danger').trim()) || '#ff5b54';

let timerEndsAt = null;
let timerInterval = null;
let lastTurnSig = '';
let autoSkipFired = false;

let sellEndsAt = null;
let sellInterval = null;
let sellWindow = 0;
let lastBidSig = '';

function setSubmitting(value) {
  submitting = value;
  const btn1 = document.getElementById('submit');
  const btn2 = document.getElementById('skip');
  if (btn1) btn1.disabled = value;
  if (btn2) btn2.disabled = value;
}

function showError(msg) {
  const el = document.getElementById('error');
  if (el) el.textContent = msg;
}

function ringSvg(arcId, textId, initialText) {
  return '<svg class="timer-svg" width="60" height="60" viewBox="0 0 60 60">' +
      '<circle cx="30" cy="30" r="26" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="4"/>' +
      '<circle id="' + arcId + '" cx="30" cy="30" r="26" fill="none" stroke="#f6b53c" stroke-width="4" ' +
        'stroke-dasharray="' + TIMER_C + '" stroke-dashoffset="0" transform="rotate(-90 30 30)"/>' +
      '<text id="' + textId + '" x="30" y="36" text-anchor="middle" font-size="18" font-weight="700">' +
        (initialText != null ? initialText : '') + '</text>' +
    '</svg>';
}

function render(state) {
  if (state && state.unauthorized) {
    document.getElementById('content').innerHTML = '<div class="invalid">Session expired or invalid.</div>';
    return;
  }

  const key = JSON.stringify([
    state.phase, state.isYourTurnToOpen, state.currentTurnCaptain,
    state.player, state.highestBid, state.byCaptain,
    state.yourMaxBid, state.smallBlind, state.openPlayers,
    state.youAreFull, state.sellMode,
  ]);
  if (key === lastKey) return;
  lastKey = key;

  const oldAmount = document.getElementById('amount');
  const oldPlayer = document.getElementById('player-select');
  const savedAmount = oldAmount ? oldAmount.value : '';
  const savedPlayer = oldPlayer ? oldPlayer.value : '';
  const focusedId = document.activeElement ? document.activeElement.id : '';

  const root = document.getElementById('content');

  if (state.phase === STATUSES.FINISHED) {
    root.innerHTML = '<div class="finished">Auction complete!' +
      '<span class="state-hint">Thanks for drafting, <b>' + esc(captain) + '</b>, good luck in the tournament!<span class="signoff">— VioSolip</span></span></div>';
    return;
  }

  if (state.phase === STATUSES.OPENING) {
    if (state.isYourTurnToOpen) {
      renderOpeningBid(root, state);
    } else {
      const turnCap = state.currentTurnCaptain || 'someone';
      root.innerHTML = '<div class="waiting">Waiting for <b>' + esc(turnCap) + '</b> to choose a player…</div>';
      return;
    }
  } else if (state.phase === STATUSES.BIDDING) {
    renderRegularBid(root, state);
  } else {
    root.innerHTML = '<div class="waiting">Waiting for the next auction…' +
      '<span class="state-hint">While you wait, check out the <b>Auction Rules &amp; Teams page</b> in the bottom-right corner.</span></div>';
    return;
  }

  const newAmount = document.getElementById('amount');
  const newPlayer = document.getElementById('player-select');
  if (newAmount && savedAmount) newAmount.value = savedAmount;
  if (newPlayer && savedPlayer) newPlayer.value = savedPlayer;
  if (focusedId) {
    const el = document.getElementById(focusedId);
    if (el) el.focus();
  }
}

function renderOpeningBid(root, state) {
  let options = '<option value="">— Choose a player —</option>';
  const players = state.openPlayers || [];
  for (let i = 0; i < players.length; i++) {
    options += '<option value="' + esc(players[i]) + '">' + esc(players[i]) + '</option>';
  }

  root.innerHTML =
    '<div class="panel">' +
      '<div class="opening-row">' +
        '<div class="opening-prompt">Your turn — pick a player and place your opening bid</div>' +
        ringSvg('timer-arc', 'timer-text', OPENING_TIMEOUT) +
      '</div>' +
      '<select id="player-select">' + options + '</select>' +
      '<div class="max-line">Min opening bid: <b>$' + state.smallBlind + '</b> &nbsp;•&nbsp; Your max bid: <b>$' + state.yourMaxBid + '</b></div>' +
      '<div class="bid-row">' +
        '<input id="amount" type="number" min="' + state.smallBlind + '" step="1" placeholder="Opening bid">' +
        '<button id="submit">Place bid</button>' +
      '</div>' +
      '<div class="error" id="error"></div>' +
      '<div class="skip-row"><button id="skip" class="skip-btn">Skip your turn</button></div>' +
    '</div>';

  document.getElementById('submit').onclick = submitOpeningBid;
  document.getElementById('skip').onclick = submitSkip;
  document.getElementById('amount').onkeydown = function (e) { if (e.key === 'Enter') submitOpeningBid(); };
}

function syncTimer(state) {
  const sig = state.phase + '|' + state.currentTurnCaptain + '|' + (state.isYourTurnToOpen ? 'Y' : 'N');
  if (sig !== lastTurnSig) {
    lastTurnSig = sig;
    autoSkipFired = false;
    timerEndsAt = state.isYourTurnToOpen ? Date.now() + (state.secondsRemaining || 0) * 1000 : null;
  }

  if (timerEndsAt && !timerInterval) {
    timerInterval = setInterval(tickTimer, 100);
    tickTimer();
  } else if (!timerEndsAt && timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function tickTimer() {
  if (!timerEndsAt) return;
  const remainingSec = Math.max(0, (timerEndsAt - Date.now()) / 1000);

  const arc = document.getElementById('timer-arc');
  const text = document.getElementById('timer-text');
  if (arc && text) {
    const fraction = Math.min(1, (OPENING_TIMEOUT - remainingSec) / OPENING_TIMEOUT);
    arc.setAttribute('stroke-dashoffset', String(TIMER_C * fraction));
    text.textContent = String(Math.ceil(remainingSec));
    arc.setAttribute('stroke', remainingSec < 10 ? RING_URGENT : RING);
  }

  if (remainingSec <= 0 && !autoSkipFired) {
    autoSkipFired = true;
    postJson('/api/skip', { captain: captain });
    // server broadcasts the advance; no manual refresh needed
  }
}

function syncSellTimer(state) {
  const active = state.phase === STATUSES.BIDDING && state.sellMode === SELL_MODE_AUTO;
  if (!active) {
    if (sellInterval) { clearInterval(sellInterval); sellInterval = null; }
    sellEndsAt = null;
    lastBidSig = '';
    return;
  }
  const sig = state.highestBid + '|' + state.byCaptain;
  if (sig !== lastBidSig) {
    lastBidSig = sig;
    sellWindow = state.sellWindowSeconds || 0;
    sellEndsAt = Date.now() + (state.sellSecondsRemaining || 0) * 1000;
  }
  if (sellEndsAt && !sellInterval) {
    sellInterval = setInterval(tickSellTimer, 100);
    tickSellTimer();
  }
}

function tickSellTimer() {
  if (!sellEndsAt) return;
  const remainingSec = Math.max(0, (sellEndsAt - Date.now()) / 1000);

  const arc = document.getElementById('sell-arc');
  const text = document.getElementById('sell-text');
  if (arc && text && sellWindow > 0) {
    const fraction = Math.min(1, (sellWindow - remainingSec) / sellWindow);
    arc.setAttribute('stroke-dashoffset', String(TIMER_C * fraction));
    text.textContent = String(Math.ceil(remainingSec));
    arc.setAttribute('stroke', remainingSec < 5 ? RING_URGENT : RING);
  }

  const label = document.getElementById('sell-label');
  if (label) label.textContent = remainingSec <= 0 ? 'Selling…' : 'Player will be sold in';
}

function renderRegularBid(root, state) {
  const leadingYou = state.byCaptain === captain;
  const byText = state.byCaptain
    ? (leadingYou ? 'by <span class="leading-you">you</span>' : 'by ' + esc(state.byCaptain))
    : 'No bids yet';

  const pricedOut = !state.youAreFull && state.yourMaxBid <= state.highestBid;

  const bidControls = state.youAreFull
    ? '<div class="team-full">Your team is full — you can\'t place bids.</div>'
    : pricedOut
      ? '<div class="priced-out">Max bid reached ($' + state.yourMaxBid + ') — you can\'t outbid this.</div>'
      : '<div class="bid-row">' +
          '<input id="amount" type="number" min="' + (state.highestBid + 1) + '" step="1" placeholder="Your bid">' +
          '<button id="submit">Bid</button>' +
        '</div>';

  const timerHtml = state.sellMode === SELL_MODE_AUTO
    ? '<div class="sell-timer-row">' +
        '<div class="sell-prompt" id="sell-label">Player will be sold in</div>' +
        ringSvg('sell-arc', 'sell-text', '') +
      '</div>'
    : '';

  root.innerHTML =
    '<div class="player-card">' +
      timerHtml +
      '<div class="card-eyebrow">On the block</div>' +
      '<div class="player">' + esc(state.player) + '</div>' +
      '<div class="bid-stat">' +
        '<div class="bid-label">Highest bid</div>' +
        '<div class="bid-figure' + (leadingYou ? ' leading-you' : '') + '">$' + state.highestBid + '</div>' +
        '<div class="bid-by">' + byText + '</div>' +
      '</div>' +
      '<div class="max-line">Your max bid: <b>$' + state.yourMaxBid + '</b></div>' +
      bidControls +
      '<div class="error" id="error"></div>' +
    '</div>';

  if (!state.youAreFull && !pricedOut) {
    document.getElementById('submit').onclick = submitRegularBid;
    document.getElementById('amount').onkeydown = function (e) { if (e.key === 'Enter') submitRegularBid(); };
  }
}

async function submitOpeningBid() {
  if (submitting) return;
  const player = document.getElementById('player-select').value;
  const amount = Number(document.getElementById('amount').value);
  if (!player) { showError('Pick a player first.'); return; }
  if (!amount) { showError('Enter an opening bid.'); return; }
  if (!Number.isInteger(amount)) { showError('Bid must be a whole number.'); return; }
  setSubmitting(true);
  showError('');
  const res = await postJson('/api/opening-bid', { captain: captain, player: player, amount: amount });
  setSubmitting(false);
  if (res && res.ok) { lastKey = ''; } else { showError(res ? res.error : 'Something went wrong.'); }
}

async function submitSkip() {
  if (submitting) return;
  setSubmitting(true);
  showError('');
  const res = await postJson('/api/skip', { captain: captain });
  setSubmitting(false);
  if (res && res.ok) { lastKey = ''; } else { showError(res ? res.error : 'Something went wrong.'); }
}

async function submitRegularBid() {
  if (submitting) return;
  const amount = Number(document.getElementById('amount').value);
  if (!amount) return;
  if (!Number.isInteger(amount)) { showError('Bid must be a whole number.'); return; }
  setSubmitting(true);
  showError('');
  const res = await postJson('/api/bid', { captain: captain, amount: amount });
  setSubmitting(false);
  if (res && res.ok) {
    const amt = document.getElementById('amount');
    if (amt) amt.value = '';
    lastKey = '';
  } else {
    showError(res ? res.error : 'Something went wrong.');
  }
}

let lastSoldSig = '';
function updateSoldBanner(state) {
  const banner = document.getElementById('sold-banner');
  if (!banner) return;
  const m = state && state.soldMessage;
  const sig = m ? (m.player + '|' + m.winner + '|' + m.bid) : '';
  if (sig === lastSoldSig) return;
  lastSoldSig = sig;
  banner.innerHTML = m
    ? '<div class="sold-banner"><span class="sold-tag">Sold</span>'
        + '<span>' + esc(m.player) + ' → ' + esc(m.winner) + ' &nbsp;·&nbsp; $' + esc(m.bid) + '</span></div>'
    : '';
}

function onState(state) {
  if (!state) return;
  render(state);
  syncTimer(state);
  syncSellTimer(state);
  updateSoldBanner(state);
}

connectState('?captain=' + encodeURIComponent(captain), onState);
