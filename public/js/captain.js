/* Captain page client. Ported from Index.html. State arrives over the WebSocket
   (connectState) instead of 1s polling of getState; actions go over fetch POST
   (postJson) instead of google.script.run, but return the same { ok, error } shape so
   the rest of the logic is unchanged. esc()/toggleInfo()/connectState()/postJson() come
   from shared.js. captain/OPENING_TIMEOUT are injected by captain.ejs. Auth is a session
   cookie set when the invite link was opened, so no secret travels in the URL or requests. */

const captain = window.CAPTAIN;
const OPENING_TIMEOUT = window.OPENING_TIMEOUT;

const STATUSES = { OPENING: 'OPENING', BIDDING: 'BIDDING', CLOSED: 'CLOSED', FILLUP: 'FILLUP', FINISHED: 'FINISHED' };
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
    state.player, state.playerImage, state.priceCeiling, state.highestBid, state.byCaptain,
    state.yourMaxBid, state.smallBlind, state.openPlayers,
    state.youAreFull, state.sellMode, state.youAreBroke, state.yourOpenSlots,
    state.fillPicker, state.isYourFillPick, state.fillPosition, state.fillPickGroups,
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

  if (state.phase === STATUSES.FILLUP) {
    renderFillUp(root, state);
  } else if (state.phase === STATUSES.OPENING) {
    if (state.isYourTurnToOpen) {
      renderOpeningBid(root, state);
    } else {
      const turnCap = state.currentTurnCaptain || 'someone';
      root.innerHTML = '<div class="waiting">Waiting for <b>' + esc(turnCap) + '</b> to choose a player…</div>' + brokeBox(state);
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
  updateRangeWarn();   // re-apply the typed-amount warning after a re-render
  if (newPlayer && savedPlayer) newPlayer.value = savedPlayer;
  if (newPlayer) updateMinBid(state);   // re-apply the restored pick's tier minimum
  if (focusedId) {
    const el = document.getElementById(focusedId);
    if (el) el.focus();
  }
}

// ----- fill-up round (#7) -----

const ORDINALS = ['1st', '2nd', '3rd'];
function ordinal(n) { return ORDINALS[n - 1] || (n + 'th'); }

function renderFillUp(root, state) {
  const tag = '<span class="fu-tag">FILL-UP ROUND</span>';
  if (state.youAreFull || !state.fillPosition) {
    root.innerHTML = '<div class="waiting">' + tag + '<br>Your team is complete. Waiting for the others to finish their picks…</div>';
    return;
  }
  if (!state.isYourFillPick) {
    const n = state.yourOpenSlots || 0;
    root.innerHTML = '<div class="waiting">' + tag + '<br>Waiting for <b>' + esc(state.fillPicker || 'someone') + '</b> to pick…<br>' +
      '<span class="pos-badge">you pick ' + ordinal(state.fillPosition) + ' · ' + n + ' slot' + (n === 1 ? '' : 's') + '</span></div>';
    return;
  }
  // Your pick: slot pips + the pickable players grouped by tier (base first, then tiers with quota left).
  const slots = state.teamSlots || 0;
  const filled = Math.max(0, slots - (state.yourOpenSlots || 0));
  let pips = '';
  for (let i = 0; i < slots; i++) pips += '<span' + (i < filled ? ' class="filled"' : '') + '></span>';
  let options = '<option value="">— Choose a player —</option>';
  let quotaHint = '';
  for (const g of state.fillPickGroups || []) {
    const label = g.base ? g.label + ' (base)' : g.label + ' · ' + g.quotaLeft + ' pick' + (g.quotaLeft === 1 ? '' : 's') + ' left';
    options += '<optgroup label="' + esc(label) + '">' + g.players.map((n) => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('') + '</optgroup>';
    if (!g.base && !quotaHint) quotaHint = '<div class="pickhint">Players above the base tier are first come, first served: only the shown number can still be picked by anyone in the fill-up round.</div>';
  }
  root.innerHTML = '<div class="panel">' + tag +
    '<div class="opening-prompt">Your pick — choose a player for $0</div>' +
    '<div class="slot-pips">' + pips + '</div>' +
    '<select id="player-select">' + options + '</select>' + quotaHint +
    '<div class="bid-row pick-row"><button id="submit">Pick player</button></div>' +
    '<div class="error" id="error"></div></div>';
  document.getElementById('submit').onclick = submitFillPick;
}

async function submitFillPick() {
  if (submitting) return;
  const player = document.getElementById('player-select').value;
  if (!player) { showError('Pick a player first.'); return; }
  setSubmitting(true);
  showError('');
  const res = await postJson('/api/fill-pick', { captain: captain, player: player });
  setSubmitting(false);
  if (res && res.ok) { lastKey = ''; } else { showError(res ? res.error : 'Something went wrong.'); }
}

// Broke (#7): a neutral box (a state, not an error) with the no-money coin, how much is left and
// how many slots the captain will fill in the fill-up round. '' when not broke.
function brokeBox(state) {
  if (!state.youAreBroke) return '';
  const n = state.yourOpenSlots || 0;
  return '<div class="broke-box">' + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v9M14.6 9.3c-.5-.8-1.5-1.3-2.6-1.3-1.5 0-2.6.8-2.6 2s1.2 1.6 2.6 1.9 2.6.8 2.6 2-1.1 2-2.6 2c-1.2 0-2.2-.5-2.7-1.4"/><path d="M4 20 20 4"/></svg>' + '<div>You\'re broke' +
    '<span class="sub">You have <b>$' + state.yourMaxBid + '</b> left — not enough for any player still in the pool. ' +
    'You\'ll fill your remaining <b>' + n + ' slot' + (n === 1 ? '' : 's') + '</b> for $0 in the fill-up round after the auction.</span></div></div>';
}

// Per-player minimum opening bid for the current dropdown (name -> minBid), refreshed each render.
let openingMins = {};

function renderOpeningBid(root, state) {
  let options = '<option value="">— Choose a player —</option>';
  const players = state.openPlayers || [];   // [{name, tier, minBid}]
  openingMins = {};
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    openingMins[p.name] = p.minBid;
    const label = p.tier ? p.name + ' (' + p.tier + ' · min $' + p.minBid + ')' : p.name;
    options += '<option value="' + esc(p.name) + '">' + esc(label) + '</option>';
  }

  root.innerHTML =
    '<div class="panel">' +
      '<div class="opening-row">' +
        '<div class="opening-prompt">Your turn — pick a player and place your opening bid</div>' +
        ringSvg('timer-arc', 'timer-text', OPENING_TIMEOUT) +
      '</div>' +
      '<select id="player-select">' + options + '</select>' +
      '<div class="max-line">Min opening bid: <b id="min-bid">$' + state.smallBlind + '</b> &nbsp;•&nbsp; Your budget: <b>$' + state.yourMaxBid + '</b></div>' +
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
  document.getElementById('player-select').onchange = function () { updateMinBid(state); };
}

/** Point the "Min opening bid" line + the amount input's min at the selected player's minimum
 *  (their tier's, or the default when no player is picked / the player is untiered). */
function updateMinBid(state) {
  const sel = document.getElementById('player-select');
  const pick = sel ? sel.value : '';
  const min = (pick && openingMins[pick] != null) ? openingMins[pick] : state.smallBlind;
  const label = document.getElementById('min-bid');
  if (label) label.textContent = '$' + min;
  const amount = document.getElementById('amount');
  if (amount) amount.min = String(min);
}

function syncTimer(state) {
  // While a takeover banner (opening reveal or sold) owns the screen, hold the opening timer — the
  // server defers the opening deadline to match, and resetting lastTurnSig re-anchors it (fresh,
  // full clock) the moment the banner clears.
  if (state.openingMessage || state.soldMessage) {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    timerEndsAt = null;
    lastTurnSig = '';
    return;
  }
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
  // While the opening-bid announcement is showing, the reveal owns the screen (the bidding card is
  // hidden — see updateOpeningBanner). Just make sure the countdown re-anchors to a fresh window
  // the moment the announcement clears (the server defers the window to match).
  if (state.openingMessage) {
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

  const pricedOut = !state.youAreFull && !state.youAreBroke && state.yourMaxBid <= state.highestBid;
  // Tier price ceiling: the highest bid above it turns the card red; typing above it warns too.
  const ceiling = state.priceCeiling;
  const highOver = ceiling != null && state.highestBid > ceiling;

  const bidControls = state.youAreFull
    ? '<div class="team-full">Your team is full — you can\'t place bids.</div>'
    : state.youAreBroke
      ? brokeBox(state)
    : pricedOut
      ? '<div class="priced-out">Budget reached ($' + state.yourMaxBid + ') — you can\'t outbid this.</div>'
      : '<div class="bid-row">' +
          '<input id="amount" type="number" min="' + (state.highestBid + 1) + '" step="1" placeholder="Your bid"' +
            (ceiling != null ? ' data-ceiling="' + ceiling + '"' : '') + '>' +
          '<button id="submit">Bid</button>' +
        '</div>';

  const timerHtml = state.sellMode === SELL_MODE_AUTO
    ? '<div class="sell-timer-row">' +
        '<div class="sell-prompt" id="sell-label">Player will be sold in</div>' +
        ringSvg('sell-arc', 'sell-text', '') +
      '</div>'
    : '';

  root.innerHTML =
    '<div class="player-card' + (highOver ? ' over' : '') + '">' +
      timerHtml +
      '<div class="card-eyebrow">On the block</div>' +
      (state.playerImage   // player card (#8), shown for the whole bidding
        ? '<img class="bid-card-img" src="' + esc(state.playerImage) + '" alt="' + esc(state.player) + '">'
        : '') +
      '<div class="player">' + esc(state.player) + '</div>' +
      '<div class="bid-stat">' +
        '<div class="bid-label">Highest bid' + (highOver ? '<span class="over-tag">Rip-off</span>' : '') + '</div>' +
        '<div class="bid-figure' + (leadingYou ? ' leading-you' : '') + '">$' + state.highestBid + '</div>' +
        '<div class="bid-by">' + byText + '</div>' +
      '</div>' +
      '<div class="max-line">Your budget: <b>$' + state.yourMaxBid + '</b></div>' +
      bidControls +
      (ceiling != null
        ? '<div class="range-warn" id="range-warn" data-high-over="' + (highOver ? 1 : 0) + '"' + (highOver ? '' : ' hidden') + '>⚠ Tier price range exceeded</div>'
        : '') +
      '<div class="error" id="error"></div>' +
    '</div>';

  if (!state.youAreFull && !state.youAreBroke && !pricedOut) {
    document.getElementById('submit').onclick = submitRegularBid;
    document.getElementById('amount').onkeydown = function (e) { if (e.key === 'Enter') submitRegularBid(); };
    document.getElementById('amount').oninput = updateRangeWarn;
  }
}

/** Red input + the "Tier price range exceeded" line while the typed bid is above the ceiling (the
 *  line also stays while the highest bid itself is above it). Warning only — the bid still goes through. */
function updateRangeWarn() {
  const input = document.getElementById('amount');
  const warn = document.getElementById('range-warn');
  if (!warn) return;
  const ceiling = input && input.dataset.ceiling !== undefined ? Number(input.dataset.ceiling) : null;
  const typedOver = ceiling != null && input.value !== '' && Number(input.value) > ceiling;
  if (input) input.classList.toggle('over', typedOver);
  const highOver = warn.dataset.highOver === '1';
  warn.hidden = !(typedOver || highOver);
  // Only the typed amount is too high (the current bid isn't yet): say it's their bid that will exceed it.
  const text = highOver ? '⚠ Tier price range exceeded' : '⚠ Your bid will exceed the tier price range';
  if (warn.textContent !== text) warn.textContent = text;
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
  const sig = m ? (m.player + '|' + m.winner + '|' + m.bid + '|' + (m.kind || '') + '|' + !!m.over) : '';
  if (sig === lastSoldSig) return;
  lastSoldSig = sig;
  const pick = !!(m && m.kind === 'pick');
  banner.innerHTML = m
    ? '<div class="sold-banner' + (m.over ? ' over' : '') + '"><span class="sold-tag">' + (pick ? 'Pick' : 'Sold') + '</span>'
        + '<span>' + esc(m.player) + ' → ' + esc(m.winner) + ' &nbsp;·&nbsp; $' + esc(m.bid) + (pick ? ' fill-up pick' : '') + '</span>'
        + (m.over ? '<span class="over-tag">Rip-off</span>' : '') + '</div>'
    : '';
}

// Opening-bid announcement: image above "X placed a $N opening bid on Y", shown for
// openingMessageSeconds (server-timed; it re-pushes openingMessage:null when the window ends).
let lastOpeningSig = '';
function updateOpeningBanner(state) {
  const banner = document.getElementById('opening-banner');
  if (!banner) return;
  const m = state && state.openingMessage;
  const sig = m ? (m.player + '|' + m.bidder + '|' + m.bid + '|' + (m.image || '')) : '';
  if (sig === lastOpeningSig) return;
  lastOpeningSig = sig;
  if (!m) { banner.innerHTML = ''; return; }
  const img = m.image
    ? '<img class="opening-img" src="' + esc(m.image) + '" alt="' + esc(m.player) + '" decoding="async">'
    : '';
  banner.innerHTML = '<div class="opening-card">' + img +
    '<div class="opening-text"><span class="opening-by">' + esc(m.bidder) + '</span> placed a ' +
    '<span class="opening-bid">$' + esc(m.bid) + '</span> opening bid on ' +
    '<span class="opening-player">' + esc(m.player) + '</span></div></div>';
}

// A takeover banner (opening reveal or sold) owns the screen: hide the bidding/opening UI while
// either shows, so the next opening UI only appears once the banner's timed window ends.
function updateContentVisibility(state) {
  const content = document.getElementById('content');
  if (!content) return;
  const takeover = !!(state.openingMessage || (state.soldMessage && state.soldMessage.kind !== 'pick'));
  content.style.display = takeover ? 'none' : '';
}

function onState(state) {
  if (!state) return;
  render(state);
  syncTimer(state);
  syncSellTimer(state);
  updateSoldBanner(state);
  updateOpeningBanner(state);
  updateContentVisibility(state);
}

connectState('?captain=' + encodeURIComponent(captain), onState);
