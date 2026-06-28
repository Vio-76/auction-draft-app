/* Spectator board. Build-once / update-in-place rendering (no whole-grid innerHTML, no
   icon re-decode → no flicker) — ported from Board.html. The old poll/jitter/backoff/
   cache/visibility machinery is gone: state arrives over the WebSocket (connectState).
   `ROLES` is injected by an inline script in board.ejs before this file loads. */

let cardEls = {};        // captain -> { el, ...refs }
let messageShown = false;
let poolCols = null;     // role key -> { col, list, count }
let poolPrefix = null;   // 3-letter role prefix -> role key
let turnChips = null;    // [chip elements] in seat order

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
    updateCard(card, t, t.full);
    if (root.children[i] !== card.el) root.insertBefore(card.el, root.children[i] || null);
  }
  for (const cap in cardEls) {
    if (!seen[cap]) { root.removeChild(cardEls[cap].el); delete cardEls[cap]; }
  }

  updateSub(teams.length);
  renderPool(state.openPlayers || []);
  renderTurn(state.turn);
}

function showMessage(root, msg) {
  root.innerHTML = '<div class="board-empty">' + msg + '</div>';
  cardEls = {};
  messageShown = true;
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

  return card;
}

function updateCard(card, t, dim) {
  setText(card.captainName, t.captain);
  setText(card.captainPrice, '$' + t.captainPrice);
  setText(card.maxBid, '$' + t.maxBid);
  card.maxBid.classList.toggle('dim', !!dim);

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

  const finished = turn.phase === 'FINISHED' || turn.currentIndex < 0;
  for (let i = 0; i < turnChips.length; i++) {
    const chip = turnChips[i];
    chip.querySelector('.turn-name').textContent = names[i];
    chip.classList.toggle('current', !finished && i === turn.currentIndex);
    chip.classList.toggle('full', turn.full && turn.full[names[i]] === true);
  }

  const badge = document.getElementById('turn-badge');
  if (badge) {
    if (finished) badge.textContent = 'Complete';
    else if (turn.mode === 'SNAKE') badge.textContent = 'Snake ' + (turn.direction === 'UP' ? '←' : '→');
    else badge.textContent = 'Waterfall →';
  }

  document.getElementById('turn-section').style.display = '';
}

// ----- live data over WebSocket -----
connectState('?view=board', render);
