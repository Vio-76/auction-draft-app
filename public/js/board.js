/* Spectator board. Build-once / update-in-place rendering (no whole-grid innerHTML, no
   icon re-decode → no flicker) — ported from Board.html. The old poll/jitter/backoff/
   cache/visibility machinery is gone: state arrives over the WebSocket (connectState).
   `ROLES` is injected by an inline script in board.ejs before this file loads. */

let cardEls = {};        // captain -> { el, ...refs }
let messageShown = false;
let poolCols = null;     // role key -> { col, list, count }
let poolPrefix = null;   // 3-letter role prefix -> role key
let turnChips = null;    // [chip elements] in seat order

// Live-bid countdown (AUTO mode): anchored locally and animated every frame for a fluid bar,
// re-anchored only when the bid changes; frozen while the admin has paused. Colors follow the
// active theme.
let liveRAF = null, liveEndsAt = 0, liveWindow = 0, liveBidSig = '', livePaused = false;
const _liveCss = getComputedStyle(document.body);
const LIVE_ACCENT = (_liveCss.getPropertyValue('--accent').trim()) || '#f6b53c';
const LIVE_URGENT = (_liveCss.getPropertyValue('--danger').trim()) || '#ff5b54';

// ----- team cards -----

function render(state) {
  const root = document.getElementById('board');
  if (!state) return;
  if (state.error) { showMessage(root, esc(state.error)); return; }

  const teams = state.teams || [];
  if (!teams.length) { showMessage(root, 'No teams yet.'); updateSub(0); return; }
  if (messageShown) { root.innerHTML = ''; cardEls = {}; messageShown = false; }

  const seen = {};
  for (let i = 0; i < teams.length; i++) {
    const t = teams[i];
    seen[t.captain] = true;
    let card = cardEls[t.captain];
    if (!card) card = cardEls[t.captain] = buildCard(t);
    updateCard(card, t, t.full || t.pricedOut);   // dim max bid when full or priced out
    if (root.children[i] !== card.el) root.insertBefore(card.el, root.children[i] || null);
  }
  for (const cap in cardEls) {
    if (!seen[cap]) { root.removeChild(cardEls[cap].el); delete cardEls[cap]; }
  }

  updateSub(teams.length);
  renderLiveBid(state.liveBid);
  renderPool(state.openPlayers || []);
  renderTurn(state.turn);
}

function renderLiveBid(lb) {
  const sec = document.getElementById('livebid-section');
  if (!sec) return;
  if (!lb || !lb.player) {
    sec.style.display = 'none'; sec.classList.remove('paused');
    stopLiveLoop(); liveBidSig = ''; livePaused = false; return;
  }

  setText(document.getElementById('livebid-player'), lb.player);
  setText(document.getElementById('livebid-amount'), '$' + lb.highestBid);
  const byEl = document.getElementById('livebid-by');
  byEl.innerHTML = lb.byCaptain ? 'by <span class="liveband-name">' + esc(lb.byCaptain) + '</span>' : 'No bids yet';
  sec.style.display = '';

  const secsEl = document.getElementById('livebid-secs');
  const track = document.getElementById('livebid-track');
  const hasTimer = typeof lb.window === 'number' && typeof lb.secondsRemaining === 'number' && lb.window > 0;

  if (!hasTimer) {                      // MANUAL mode: no clock, just the bold bid line
    stopLiveLoop(); liveBidSig = ''; livePaused = false;
    sec.classList.remove('paused');
    if (secsEl) secsEl.style.display = 'none';
    if (track) track.style.display = 'none';
    return;
  }
  if (secsEl) secsEl.style.display = '';
  if (track) track.style.display = '';

  if (lb.paused) {                      // frozen while paused — hold the bar where it stopped
    stopLiveLoop();
    livePaused = true;
    liveWindow = lb.window;
    liveBidSig = lb.highestBid + '|' + lb.byCaptain;   // so resume re-anchors
    sec.classList.add('paused');
    paintLive(lb.secondsRemaining);
    return;
  }

  sec.classList.remove('paused');
  // Re-anchor on a new bid (snap back to full) or right after resuming; otherwise keep ticking.
  const sig = lb.highestBid + '|' + lb.byCaptain;
  if (sig !== liveBidSig || livePaused) {
    livePaused = false;
    liveBidSig = sig;
    liveWindow = lb.window;
    liveEndsAt = Date.now() + lb.secondsRemaining * 1000;
  }
  startLiveLoop();
}

/** Paint the bar + seconds for a given remaining time (shared by the live loop and pause). */
function paintLive(remaining) {
  const fill = document.getElementById('livebid-fill');
  const secsEl = document.getElementById('livebid-secs');
  if (!liveWindow) return;
  const frac = Math.max(0, Math.min(1, remaining / liveWindow));
  const urgent = remaining <= 5;
  if (fill) { fill.style.width = (frac * 100) + '%'; fill.style.background = urgent ? LIVE_URGENT : LIVE_ACCENT; }
  if (secsEl) { secsEl.textContent = Math.ceil(remaining) + 's'; secsEl.classList.toggle('urgent', urgent); }
}

function tickLive() { paintLive(Math.max(0, (liveEndsAt - Date.now()) / 1000)); }

// Animate per frame (rAF) for a fluid bar instead of chunky 100ms steps.
function startLiveLoop() {
  if (liveRAF) return;
  const step = function () { tickLive(); liveRAF = requestAnimationFrame(step); };
  liveRAF = requestAnimationFrame(step);
}
function stopLiveLoop() {
  if (liveRAF) { cancelAnimationFrame(liveRAF); liveRAF = null; }
}

function showMessage(root, msg) {
  root.innerHTML = '<div class="board-empty">' + msg + '</div>';
  cardEls = {};
  messageShown = true;
  renderLiveBid(null);
  hidePool();
  hideTurn();
}

function updateSub(n) {
  const sub = document.getElementById('board-sub');
  if (sub) sub.textContent = n + (n === 1 ? ' team' : ' teams');
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function setText(node, v) { if (node.textContent !== v) node.textContent = v; }

function buildCard(t) {
  const card = { el: el('div', 'team-card') };

  const head = el('div', 'team-head');
  card.maxBid = el('span', 'team-maxbid');
  head.appendChild(card.maxBid);
  head.appendChild(el('span', 'team-maxbid-label', '(Max bid)'));
  card.el.appendChild(head);

  const roster = el('div', 'roster');

  const capRow = el('div', 'roster-row captain');
  const capName = el('span', 'slot-name');
  card.captainName = el('span', 'cap-name');
  capName.appendChild(card.captainName);
  capRow.appendChild(capName);
  card.captainPrice = el('span', 'slot-price');
  capRow.appendChild(card.captainPrice);
  roster.appendChild(capRow);

  card.slots = [];
  const slotCount = (t.players || []).length;
  for (let i = 0; i < slotCount; i++) {
    const row = el('div', 'roster-row');
    const name = el('span', 'slot-name');
    const price = el('span', 'slot-price');
    row.appendChild(name);
    row.appendChild(price);
    roster.appendChild(row);
    card.slots.push({ row: row, name: name, price: price });
  }
  card.el.appendChild(roster);

  const rolesWrap = el('div', 'roles');
  card.roles = [];
  for (let i = 0; i < ROLES.length; i++) {
    const r = ROLES[i];
    const rEl = el('div', 'role role-' + r.key, r.hasIcon ? '' : r.label.slice(0, 3));
    rEl.title = r.label;
    rolesWrap.appendChild(rEl);
    card.roles.push(rEl);
  }
  card.el.appendChild(rolesWrap);

  // Multi-op.gg link for the finished roster — hidden until the auction is FINISHED.
  card.oppg = el('a', 'team-oppg', 'Team op.gg ↗');
  card.oppg.target = '_blank';
  card.oppg.rel = 'noopener';
  card.oppg.style.display = 'none';
  card.el.appendChild(card.oppg);

  return card;
}

function updateCard(card, t, dim) {
  setText(card.captainName, t.captain);
  setText(card.captainPrice, '$' + t.captainPrice);
  setText(card.maxBid, '$' + t.maxBid);
  card.maxBid.classList.toggle('dim', !!dim);
  card.captainName.classList.toggle('leading', !!t.leading);   // current high bidder -> green name

  const players = t.players || [];
  for (let i = 0; i < card.slots.length; i++) {
    const s = card.slots[i];
    const p = players[i];
    if (p && p.name) {
      s.row.classList.remove('empty');
      setText(s.name, p.name);
      setText(s.price, '$' + p.price);
    } else {
      s.row.classList.add('empty');
      setText(s.name, '—');
      setText(s.price, '');
    }
  }

  const flags = t.roles || [];
  for (let i = 0; i < card.roles.length; i++) {
    card.roles[i].classList.toggle('on', !!flags[i]);
  }

  if (t.oppgUrl) {
    card.oppg.href = t.oppgUrl;
    card.oppg.style.display = '';
  } else {
    card.oppg.removeAttribute('href');
    card.oppg.style.display = 'none';
  }
}

// ----- available-players pool -----

function buildPool() {
  const grid = document.getElementById('pool');
  poolCols = {};
  poolPrefix = {};
  for (let i = 0; i < ROLES.length; i++) {
    addPoolCol(grid, ROLES[i]);
    poolPrefix[ROLES[i].key.slice(0, 3)] = ROLES[i].key;
  }
}

function addPoolCol(grid, role) {
  const col = el('div', 'pool-col');
  const head = el('div', 'pool-col-head');
  const icon = el('div', 'pool-icon role-' + role.key, role.hasIcon ? '' : role.label.slice(0, 3));
  icon.title = role.label;
  head.appendChild(icon);
  head.appendChild(el('span', 'pool-col-label', role.label));
  const count = el('span', 'pool-col-count');
  head.appendChild(count);
  col.appendChild(head);
  const list = el('div', 'pool-list');
  col.appendChild(list);
  grid.appendChild(col);
  return (poolCols[role.key] = { col: col, list: list, count: count });
}

function hidePool() {
  const sec = document.getElementById('pool-section');
  if (sec) sec.style.display = 'none';
}

function renderPool(players) {
  if (!players.length) { hidePool(); return; }
  if (!poolCols) buildPool();

  const buckets = {};
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const prefix = (p.role || '').toLowerCase().slice(0, 3);
    const bucket = poolPrefix[prefix] || 'other';
    (buckets[bucket] = buckets[bucket] || []).push(p.name);
  }

  if (buckets.other && !poolCols.other) {
    addPoolCol(document.getElementById('pool'), { key: 'other', label: 'Other', hasIcon: false });
  } else if (!buckets.other && poolCols.other) {
    poolCols.other.col.remove();
    delete poolCols.other;
  }

  for (const key in poolCols) {
    const c = poolCols[key];
    const names = buckets[key] || [];
    c.list.classList.toggle('is-empty', names.length === 0);
    c.col.classList.toggle('empty', names.length === 0);
    c.count.textContent = names.length || '';
    c.list.textContent = '';
    for (let i = 0; i < names.length; i++) c.list.appendChild(el('div', 'pool-player', names[i]));
  }

  const countEl = document.getElementById('pool-count');
  if (countEl) countEl.textContent = players.length + ' available';
  document.getElementById('pool-section').style.display = '';
}

// ----- turn-order rail -----

function hideTurn() {
  const sec = document.getElementById('turn-section');
  if (sec) sec.style.display = 'none';
}

function buildTurnRail(names) {
  const rail = document.getElementById('turn-rail');
  rail.textContent = '';
  turnChips = [];
  for (let i = 0; i < names.length; i++) {
    const chip = el('div', 'turn-chip');
    chip.appendChild(el('span', 'turn-seat', (i + 1) + '.'));
    chip.appendChild(el('span', 'turn-name', names[i]));
    rail.appendChild(chip);
    turnChips.push(chip);
  }
}

function renderTurn(turn) {
  const names = (turn && turn.order) || [];
  if (!names.length) { hideTurn(); return; }
  if (!turnChips || turnChips.length !== names.length) buildTurnRail(names);

  const finished = turn.phase === 'FINISHED';
  const paused = turn.phase === 'CLOSED';
  const active = !finished && !paused;   // only OPENING/BIDDING have a live "current" captain
  for (let i = 0; i < turnChips.length; i++) {
    const chip = turnChips[i];
    chip.querySelector('.turn-name').textContent = names[i];
    chip.classList.toggle('current', active && i === turn.currentIndex);
    chip.classList.toggle('full', turn.full && turn.full[names[i]] === true);
  }

  const badge = document.getElementById('turn-badge');
  if (badge) {
    if (finished) badge.textContent = 'Complete';
    else if (paused) badge.textContent = 'Paused';
    else if (turn.mode === 'SNAKE') badge.textContent = 'Snake ' + (turn.direction === 'UP' ? '←' : '→');
    else badge.textContent = 'Waterfall →';
  }

  document.getElementById('turn-section').style.display = '';
}

// ----- live data over WebSocket -----
connectState('?view=board', render);
