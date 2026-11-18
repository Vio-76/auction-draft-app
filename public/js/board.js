/* Spectator board. Build-once / update-in-place rendering (no whole-grid innerHTML, no
   icon re-decode → no flicker) — ported from Board.html. The old poll/jitter/backoff/
   cache/visibility machinery is gone: state arrives over the WebSocket (connectState).
   `ROLES` is injected by an inline script in board.ejs before this file loads. */

let cardEls = {};        // captain -> { el, ...refs }
let messageShown = false;
let poolCols = null;     // column key -> { col, list, count }
let poolPrefix = null;   // 3-letter role prefix -> ROLES entry
let turnChips = null;    // [chip elements] in seat order

// Live-bid countdown (AUTO mode): anchored locally and animated every frame for a fluid bar,
// re-anchored only when the bid changes; frozen while the admin has paused. Colors follow the
// active theme: --live-fill / --live-urgent if the theme sets them (e.g. wada-202's dark band),
// otherwise --accent / --danger.
let liveRAF = null, liveEndsAt = 0, liveWindow = 0, liveBidSig = '', livePaused = false;
const _liveCss = getComputedStyle(document.body);
const _liveVar = (name) => _liveCss.getPropertyValue(name).trim();
const LIVE_ACCENT = _liveVar('--live-fill') || _liveVar('--accent') || '#f6b53c';
const LIVE_URGENT = _liveVar('--live-urgent') || _liveVar('--danger') || '#ff5b54';

// ----- team cards -----

function render(state) {
  const root = document.getElementById('board');
  if (!state) return;
  if (state.error) { showMessage(root, esc(state.error)); return; }

  const teams = state.teams || [];
  if (!teams.length) { showMessage(root, 'No teams yet.'); updateSub(0); return; }
  if (messageShown) { root.innerHTML = ''; cardEls = {}; messageShown = false; }

  // Once the auction is over, max bid / budget are no longer meaningful — hide them and let the
  // card show just the final roster (+ team op.gg link).
  const finished = !!(state.turn && state.turn.phase === 'FINISHED');
  // Admin toggle: whether the available-budget bar shows at all (default on if unspecified).
  const showBudget = state.showBudgetOnBoard !== false;

  const seen = {};
  for (let i = 0; i < teams.length; i++) {
    const t = teams[i];
    seen[t.captain] = true;
    let card = cardEls[t.captain];
    if (!card) card = cardEls[t.captain] = buildCard(t);
    updateCard(card, t, t.full || t.pricedOut, finished, showBudget);   // dim max bid when full or priced out
    if (root.children[i] !== card.el) root.insertBefore(card.el, root.children[i] || null);
  }
  for (const cap in cardEls) {
    if (!seen[cap]) { root.removeChild(cardEls[cap].el); delete cardEls[cap]; }
  }

  updateSub(teams.length);
  renderOpeningBanner(state.openingMessage);
  renderSoldBanner(state.soldMessage);
  renderWaitingBanner(state.turn, !!state.openingMessage || !!state.soldMessage);
  renderLiveBid(state.liveBid, !!state.openingMessage);
  renderPool(state.openPlayers || [], state.tiers || [], state.defaultMinBid);
  renderTurn(state.turn);
}

// "Sold" banner — the same one the captain page shows, on the board too. Server-timed
// (soldMessageSeconds); re-pushed by timers.js while live so it clears on time.
let lastSoldSig = '';
function renderSoldBanner(m) {
  const banner = document.getElementById('sold-banner');
  if (!banner) return;
  const sig = m ? (m.player + '|' + m.winner + '|' + m.bid) : '';
  if (sig === lastSoldSig) return;
  lastSoldSig = sig;
  if (!m) { banner.style.display = 'none'; banner.innerHTML = ''; return; }
  banner.innerHTML = '<div class="sold-banner"><span class="sold-tag">Sold</span>'
    + '<span>' + esc(m.player) + ' → ' + esc(m.winner) + ' &nbsp;·&nbsp; $' + esc(m.bid) + '</span></div>';
  banner.style.display = '';
}

// "Waiting for X to choose a player…" during the OPENING phase — mirrors the captain page's
// non-turn view so spectators see whose opening bid we're waiting on (the turn rail also
// highlights them). Hidden outside OPENING; during BIDDING the reveal + live band show instead.
let lastWaitingSig = '';
function renderWaitingBanner(turn, suppress) {
  const banner = document.getElementById('waiting-banner');
  if (!banner) return;
  const order = (turn && turn.order) || [];
  const i = turn ? turn.currentIndex : -1;
  // Suppressed while the opening reveal is showing (an uncontestable opening auto-sells straight
  // into the next OPENING, so the two can briefly coincide — the reveal wins).
  const name = (!suppress && turn && turn.phase === 'OPENING' && i >= 0 && i < order.length) ? order[i] : '';
  if (name === lastWaitingSig) return;
  lastWaitingSig = name;
  if (!name) { banner.style.display = 'none'; banner.innerHTML = ''; return; }
  banner.innerHTML = '<div class="waiting-band">Waiting for <b>' + esc(name) + '</b> to choose a player…</div>';
  banner.style.display = '';
}

// Opening-bid announcement: image above "X placed a $N opening bid on Y", shown for
// openingMessageSeconds (server-timed — it re-pushes openingMessage:null when the window ends).
let lastOpeningSig = '';
function renderOpeningBanner(m) {
  const banner = document.getElementById('opening-banner');
  if (!banner) return;
  const sig = m ? (m.player + '|' + m.bidder + '|' + m.bid + '|' + (m.image || '')) : '';
  if (sig === lastOpeningSig) return;
  lastOpeningSig = sig;
  if (!m) { banner.style.display = 'none'; banner.innerHTML = ''; return; }
  const img = m.image
    ? '<img class="opening-img" src="' + esc(m.image) + '" alt="' + esc(m.player) + '" decoding="async">'
    : '';
  banner.innerHTML = '<div class="opening-card">' + img +
    '<div class="opening-text"><span class="opening-by">' + esc(m.bidder) + '</span> placed a ' +
    '<span class="opening-bid">$' + esc(m.bid) + '</span> opening bid on ' +
    '<span class="opening-player">' + esc(m.player) + '</span></div></div>';
  banner.style.display = '';
}

function renderLiveBid(lb, announcing) {
  const sec = document.getElementById('livebid-section');
  if (!sec) return;
  if (!lb || !lb.player) {
    sec.style.display = 'none'; sec.classList.remove('paused');
    stopLiveLoop(); liveBidSig = ''; livePaused = false; return;
  }

  // While the opening reveal is showing, it owns the screen — hide the on-the-block band entirely.
  // Resetting liveBidSig makes the band re-appear with a fresh countdown once the reveal clears.
  if (announcing) {
    sec.style.display = 'none'; sec.classList.remove('paused');
    stopLiveLoop(); liveBidSig = ''; livePaused = false;
    return;
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
  renderOpeningBanner(null);
  renderSoldBanner(null);
  renderWaitingBanner(null, false);
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

// Captain / co-captain crowns (filled / outline), drawn in currentColor so they follow the name.
const CROWN_PATH = 'M2.5 17 L4 7 L8.5 11 L12 4 L15.5 11 L20 7 L21.5 17 Z';
const CROWN_FILLED = '<path d="' + CROWN_PATH + '" fill="currentColor"/>' +
  '<rect x="2.5" y="18.5" width="19" height="2.5" rx="1" fill="currentColor"/>';
const CROWN_OUTLINE = '<path d="' + CROWN_PATH + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>' +
  '<rect x="2.5" y="18.5" width="19" height="2.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/>';
function crownIcon(inner, label) {
  const span = el('span', 'crown');
  span.title = label;
  span.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + inner + '</svg>';
  return span;
}

function buildCard(t) {
  const card = { el: el('div', 'team-card') };

  // Team identity "crest" (logo above the team name, group badge pinned top-right) — shown at the
  // very top whenever the server sends any of them (see updateCard; the server decides when they're
  // visible). Hidden by default so a card with none looks exactly as before.
  card.identity = el('div', 'team-identity');
  card.identity.style.display = 'none';
  card.teamLogo = el('img', 'team-logo');
  card.teamLogo.alt = '';
  card.teamLogo.decoding = 'async';
  card.teamName = el('span', 'team-name');
  // Group badge: a big "A"/"B" (as large as the team name) with a small "group" caption below.
  card.teamGroup = el('div', 'team-group');
  card.teamGroupLetter = el('span', 'team-group-letter');
  card.teamGroup.appendChild(card.teamGroupLetter);
  card.teamGroup.appendChild(el('span', 'team-group-label', 'group'));
  card.identity.appendChild(card.teamLogo);
  card.identity.appendChild(card.teamName);
  card.identity.appendChild(card.teamGroup);
  card.el.appendChild(card.identity);

  const head = card.head = el('div', 'team-head');
  card.maxBid = el('span', 'team-maxbid');
  head.appendChild(card.maxBid);
  card.maxBidLabel = el('span', 'team-maxbid-label', '(Max bid)');
  head.appendChild(card.maxBidLabel);
  card.el.appendChild(head);

  const roster = el('div', 'roster');

  const capRow = card.capRow = el('div', 'roster-row captain');
  const capName = el('span', 'slot-name');
  capName.appendChild(crownIcon(CROWN_FILLED, 'Captain'));
  card.captainName = el('span', 'cap-name');
  capName.appendChild(card.captainName);
  capRow.appendChild(capName);
  card.captainPrice = el('span', 'slot-price');
  capRow.appendChild(card.captainPrice);
  roster.appendChild(capRow);

  // Player slots. A slot holding the team's co-captain (always the first, see draftedPlayers) gets
  // the outline crown and the captain's name style; the crown span is hidden on ordinary slots.
  card.slots = [];
  const slotCount = (t.players || []).length;
  for (let i = 0; i < slotCount; i++) {
    const row = el('div', 'roster-row');
    const slotName = el('span', 'slot-name');
    const coIcon = crownIcon(CROWN_OUTLINE, 'Co-captain');
    coIcon.style.display = 'none';
    const name = el('span', 'slot-text');
    slotName.appendChild(coIcon);
    slotName.appendChild(name);
    const price = el('span', 'slot-price');
    row.appendChild(slotName);
    row.appendChild(price);
    roster.appendChild(row);
    card.slots.push({ row: row, name: name, price: price, coIcon: coIcon });
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

  // "Available budget" meter, under the role icons: a gold bar (how much budget the captain still
  // has) with a muted right-aligned "Budget $remaining/total". Styled quiet (see .team-budget*) to
  // stay clearly secondary to the max-bid headline.
  card.budget = el('div', 'team-budget');
  const budgetHead = el('div', 'team-budget-head');
  card.budgetVal = el('span', 'team-budget-val');
  budgetHead.appendChild(card.budgetVal);
  card.budget.appendChild(budgetHead);
  const budgetTrack = el('div', 'team-budget-track');
  card.budgetFill = el('div', 'team-budget-fill');
  budgetTrack.appendChild(card.budgetFill);
  card.budget.appendChild(budgetTrack);
  card.el.appendChild(card.budget);

  // Multi-op.gg link for the finished roster — hidden until the auction is FINISHED.
  card.oppg = el('a', 'team-oppg', 'Team op.gg ↗');
  card.oppg.target = '_blank';
  card.oppg.rel = 'noopener';
  card.oppg.style.display = 'none';
  card.el.appendChild(card.oppg);

  return card;
}

function updateCard(card, t, dim, finished, showBudget) {
  // Auction over: drop the max-bid headline and the budget meter (both meaningless now); the card
  // becomes a clean final roster. The budget bar is also hidden when the admin toggles it off.
  card.head.style.display = finished ? 'none' : '';
  card.budget.style.display = (finished || !showBudget) ? 'none' : '';

  // Team identity (logo + name + group). The server only sends what may be shown right now (name/
  // logo once FINISHED or always, per the admin setting; group once FINISHED), so just show what
  // arrived. With none of them the block stays hidden and the card looks as it always did.
  const name = t.teamName || '';
  const group = t.teamGroup || '';
  const logo = t.teamLogo || '';
  card.identity.style.display = (name || group || logo) ? '' : 'none';
  card.identity.classList.toggle('has-group', !!group);
  if (logo) {
    if (card.teamLogo.getAttribute('src') !== logo) card.teamLogo.src = logo;   // no re-fetch per push
    card.teamLogo.style.display = '';
  } else {
    card.teamLogo.removeAttribute('src');
    card.teamLogo.style.display = 'none';
  }
  setText(card.teamName, name);
  card.teamName.style.display = name ? '' : 'none';
  setText(card.teamGroupLetter, group);
  card.teamGroup.style.display = group ? '' : 'none';

  setText(card.captainName, t.captain);
  setText(card.captainPrice, '$' + t.captainPrice);
  // Full team: headline reads "Full" (max bid is a meaningless $0 by then) and the budget bar
  // greys out — done, no longer of concern to other captains. Otherwise the live max bid.
  if (t.full) {
    setText(card.maxBid, 'Full');
    setText(card.maxBidLabel, '');
  } else {
    setText(card.maxBid, '$' + t.maxBid);
    setText(card.maxBidLabel, '(Max bid)');
  }
  setText(card.budgetVal, 'Budget $' + t.leftOver + '/' + t.teamBudget);
  const budgetFrac = t.teamBudget > 0 ? Math.max(0, Math.min(1, t.leftOver / t.teamBudget)) : 0;
  card.budgetFill.style.width = (budgetFrac * 100) + '%';
  card.maxBid.classList.toggle('dim', !!dim);
  card.maxBid.classList.toggle('is-full', !!t.full);   // render "Full" as a word, not a mono figure
  card.budget.classList.toggle('full', !!t.full);      // grey the bar when settled
  card.captainName.classList.toggle('leading', !!t.leading);   // current high bidder -> green name
  card.capRow.classList.toggle('leading', !!t.leading);        // ...and its crown

  const players = t.players || [];
  let hasCo = false;
  for (let i = 0; i < card.slots.length; i++) {
    const s = card.slots[i];
    const p = players[i];
    const co = !!(p && p.name && p.coCaptain);
    if (co) hasCo = true;
    s.row.classList.toggle('co-captain', co);
    s.row.classList.toggle('leading', co && !!t.leading);       // co-captain shares the team's green
    s.coIcon.style.display = co ? '' : 'none';
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
  card.capRow.classList.toggle('has-co', hasCo);   // lighter divider between captain + co-captain

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

// Two groupings, flipped by the Role/Tier switch in the pool header:
//  - role: one column per ROLES entry (always shown, dimmed when empty) + "Other" if needed.
//  - tier: one column per tier in admin order (always shown, dimmed when empty) + "No tier" if
//    any untiered player is left; each player gets a small role icon so the role isn't lost.
// The choice is per viewer (remembered in localStorage). With no tiers configured the switch is
// hidden and the role view is used. Columns are rebuilt only when the column set changes.
let poolMode = 'role';
let poolColsSig = '';
let lastPool = { players: [], tiers: [], defaultMinBid: 0 };
try { if (localStorage.getItem('boardPoolMode') === 'tier') poolMode = 'tier'; } catch (e) { /* storage blocked */ }

function rolePrefixMap() {
  if (!poolPrefix) {
    poolPrefix = {};
    for (let i = 0; i < ROLES.length; i++) poolPrefix[ROLES[i].key.slice(0, 3)] = ROLES[i];
  }
  return poolPrefix;
}
/** The ROLES entry a player's free-text role maps to (first 3 letters), or null. */
function roleOf(p) { return rolePrefixMap()[(p.role || '').toLowerCase().slice(0, 3)] || null; }

function addPoolCol(grid, spec) {
  const col = el('div', 'pool-col');
  const head = el('div', 'pool-col-head');
  if (spec.role) {
    const icon = el('div', 'pool-icon role-' + spec.role.key, spec.role.hasIcon ? '' : spec.role.label.slice(0, 3));
    icon.title = spec.role.label;
    head.appendChild(icon);
  } else if (spec.other) {
    head.appendChild(el('div', 'pool-icon', 'Oth'));
  }
  head.appendChild(el('span', 'pool-col-label', spec.label));
  // Tier view: the recommended price range (admin free text, shown as typed) is the headline next
  // to the name; the enforced minimum sits on its own muted line underneath — a floor, not a price.
  if (spec.range) head.appendChild(el('span', 'pool-col-range', spec.range));
  const count = el('span', 'pool-col-count');
  head.appendChild(count);
  if (spec.min != null) {
    head.classList.add('has-min');
    head.appendChild(el('span', 'pool-col-min', '(minimum $' + spec.min + ')'));
  }
  col.appendChild(head);
  const list = el('div', 'pool-list');
  col.appendChild(list);
  grid.appendChild(col);
  return (poolCols[spec.key] = { col: col, list: list, count: count });
}

function hidePool() {
  const sec = document.getElementById('pool-section');
  if (sec) sec.style.display = 'none';
}

/** Small role icon in front of a player's name (tier view). Text fallback if the PNG is missing. */
function miniRoleIcon(role) {
  if (!role) return el('span', 'pool-mini-icon pool-mini-none');
  const i = el('span', 'pool-mini-icon role-' + role.key, role.hasIcon ? '' : role.label.slice(0, 1));
  i.title = role.label;
  return i;
}

function renderPool(players, tiers, defaultMinBid) {
  lastPool = { players: players, tiers: tiers || [], defaultMinBid: defaultMinBid };
  tiers = lastPool.tiers;
  if (!players.length) { hidePool(); return; }

  const hasTiers = tiers.length > 0;
  const mode = hasTiers ? poolMode : 'role';
  updatePoolSwitch(hasTiers, mode);

  // Column specs + buckets (key -> [player]) for the active grouping.
  const specs = [];
  const buckets = {};
  const put = (key, p) => { (buckets[key] = buckets[key] || []).push(p); };
  if (mode === 'tier') {
    const known = {};
    for (let i = 0; i < tiers.length; i++) {
      known[tiers[i].id] = true;
      specs.push({ key: 't' + tiers[i].id, label: tiers[i].name, range: tiers[i].range || '', min: tiers[i].minBid });
    }
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      put(p.tierId != null && known[p.tierId] ? 't' + p.tierId : 'none', p);
    }
    if (buckets.none) specs.push({ key: 'none', label: 'No tier', min: defaultMinBid });
  } else {
    for (let i = 0; i < ROLES.length; i++) specs.push({ key: ROLES[i].key, label: ROLES[i].label, role: ROLES[i] });
    for (let i = 0; i < players.length; i++) {
      const r = roleOf(players[i]);
      put(r ? r.key : 'other', players[i]);
    }
    if (buckets.other) specs.push({ key: 'other', label: 'Other', other: true });
  }

  // Rebuild the columns only when the set (or a tier's name/range/min) changes.
  const sig = mode + '|' + JSON.stringify(specs.map((s) => [s.key, s.label, s.range, s.min]));
  if (sig !== poolColsSig) {
    poolColsSig = sig;
    const grid = document.getElementById('pool');
    grid.textContent = '';
    grid.classList.toggle('by-tier', mode === 'tier');   // wider columns in the tier view (board.css)
    poolCols = {};
    for (let i = 0; i < specs.length; i++) addPoolCol(grid, specs[i]);
  }

  for (const key in poolCols) {
    const c = poolCols[key];
    const list = buckets[key] || [];
    c.list.classList.toggle('is-empty', list.length === 0);
    c.col.classList.toggle('empty', list.length === 0);
    c.count.textContent = list.length || '';
    c.list.textContent = '';
    for (let i = 0; i < list.length; i++) {
      const row = el('div', 'pool-player');
      if (mode === 'tier') {
        row.classList.add('with-icon');
        row.appendChild(miniRoleIcon(roleOf(list[i])));
        row.appendChild(el('span', 'pool-player-name', list[i].name));
      } else {
        row.textContent = list[i].name;
      }
      c.list.appendChild(row);
    }
  }

  const countEl = document.getElementById('pool-count');
  if (countEl) countEl.textContent = players.length + ' available';
  document.getElementById('pool-section').style.display = '';
}

function updatePoolSwitch(show, mode) {
  const sw = document.getElementById('pool-switch');
  if (!sw) return;
  sw.style.display = show ? '' : 'none';
  const btns = sw.querySelectorAll('button[data-mode]');
  for (let i = 0; i < btns.length; i++) {
    btns[i].setAttribute('aria-pressed', btns[i].getAttribute('data-mode') === mode ? 'true' : 'false');
  }
}

(function wirePoolSwitch() {
  const sw = document.getElementById('pool-switch');
  if (!sw) return;
  sw.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    poolMode = btn.getAttribute('data-mode') === 'tier' ? 'tier' : 'role';
    try { localStorage.setItem('boardPoolMode', poolMode); } catch (err) { /* storage blocked */ }
    renderPool(lastPool.players, lastPool.tiers, lastPool.defaultMinBid);
  });
})();

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
