/* Admin console client. Live state arrives over the WS admin channel; actions are fetch
   POSTs to /api/admin/*. Edits use prompt()/confirm() so the 1s live re-push never
   clobbers a half-typed inline field. esc()/connectState()/postJson() come from shared.js. */

let STATE = null;
let settingsInitialized = false;
let captainsSig = '';
let playersSig = '';
let turnDropdownSig = '';

// ----- actions -----

async function adminAction(path, body, confirmMsg) {
  if (confirmMsg && !confirm(confirmMsg)) return;
  const res = await postJson('/api/admin/' + path, body || {});
  if (!res || !res.ok) alert((res && res.error) || 'Action failed.');
  return res;
}

function saveSettings() {
  const patch = {
    sellMode: val('set-sellMode'),
    turnOrder: val('set-turnOrder'),
    turnDirection: val('set-turnDirection'),
    theme: val('set-theme'),
    smallBlind: numVal('set-smallBlind'),
    teamBudget: numVal('set-teamBudget'),
    teamSlots: numVal('set-teamSlots'),
    openingTimeout: numVal('set-openingTimeout'),
    autoWindow: numVal('set-autoWindow'),
    soldCooldown: numVal('set-soldCooldown'),
  };
  adminAction('settings', { patch });
}

function setTurnTo() {
  const captainId = Number(val('turn-captain'));
  if (!captainId) return;
  adminAction('turn', { captainId });
}

function forceStatus() {
  adminAction('status', { status: val('force-status') });
}

// captains
function addCaptain() {
  const name = prompt('Captain name:');
  if (!name) return;
  const code = prompt('Access code (captains use this to log in):', '') || '';
  const price = Number(prompt('Captain price:', '0')) || 0;
  adminAction('captain/add', { name, code, price });
}
function editCaptain(id) {
  const c = (STATE.captains || []).find((x) => x.id === id);
  if (!c) return;
  const name = prompt('Name:', c.name); if (name === null) return;
  const code = prompt('Code:', c.code); if (code === null) return;
  const price = prompt('Price:', c.price); if (price === null) return;
  adminAction('captain/update', { id, patch: { name, code, price: Number(price) || 0 } });
}
function deleteCaptain(id) {
  const c = (STATE.captains || []).find((x) => x.id === id);
  adminAction('captain/delete', { id }, 'Delete captain "' + (c ? c.name : id) + '"? Their drafted players return to the pool.');
}

// players
function addPlayer() {
  const name = prompt('Player name:');
  if (!name) return;
  const role = prompt('Role (e.g. Top, Jungle, Mid, ADC, Support, Fill):', '') || '';
  adminAction('player/add', { name, role });
}
function editPlayer(id) {
  const p = (STATE.players || []).find((x) => x.id === id);
  if (!p) return;
  const name = prompt('Name:', p.name); if (name === null) return;
  const role = prompt('Role:', p.role); if (role === null) return;
  adminAction('player/update', { id, patch: { name, role } });
}
function deletePlayer(id) {
  const p = (STATE.players || []).find((x) => x.id === id);
  adminAction('player/delete', { id }, 'Delete player "' + (p ? p.name : id) + '"?');
}
async function importPlayers() {
  const text = val('import-text');
  if (!text.trim()) { alert('Paste a player list first.'); return; }
  const mode = val('import-mode');
  const res = await adminAction('import', { text, mode });
  if (res && res.ok) { document.getElementById('import-text').value = ''; alert('Imported ' + res.added + ' players.'); }
}

// roster editing
function assignPlayer(id) {
  const caps = STATE.captains || [];
  const names = caps.map((c) => c.name).join(', ');
  const who = prompt('Assign to which captain?\n(' + names + ')');
  if (!who) return;
  const cap = caps.find((c) => c.name.toLowerCase() === who.trim().toLowerCase());
  if (!cap) { alert('No captain named "' + who + '".'); return; }
  const price = Number(prompt('Price:', '0')) || 0;
  adminAction('roster/assign', { playerId: id, captainId: cap.id, price });
}
function removeFromTeam(id) {
  adminAction('roster/remove', { playerId: id });
}
function editPrice(id) {
  const p = (STATE.players || []).find((x) => x.id === id);
  const price = prompt('New price:', p ? p.price : '0');
  if (price === null) return;
  adminAction('roster/price', { playerId: id, price: Number(price) || 0 });
}

// ----- rendering -----

function val(id) { const e = document.getElementById(id); return e ? e.value : ''; }
function numVal(id) { return Number(val(id)) || 0; }
function setVal(id, v) { const e = document.getElementById(id); if (e) e.value = v; }

function renderStatus(s) {
  const a = s.auction || {};
  const cells = [
    ['Phase', '<span class="pill ' + s.phase + '">' + s.phase + '</span>'],
    ['Turn', esc(s.currentTurnCaptain || '—')],
    ['On the block', esc(a.player || '—')],
    ['Highest bid', a.player ? ('$' + a.highestBid + (a.byCaptain ? ' · ' + esc(a.byCaptain) : '')) : '—'],
    ['Sell mode', s.settings.sellMode],
    ['Order', s.settings.turnOrder + (s.settings.turnOrder === 'SNAKE' ? ' ' + s.settings.turnDirection : '')],
  ];
  document.getElementById('status-bar').innerHTML = cells.map(function (c) {
    return '<div class="stat"><span class="k">' + c[0] + '</span><span class="v">' + c[1] + '</span></div>';
  }).join('');

  const soldBtn = document.getElementById('sold-btn');
  if (soldBtn) soldBtn.disabled = !s.soldArmed;
}

function fillSettingsOnce(s) {
  if (settingsInitialized) return;
  settingsInitialized = true;
  setVal('set-sellMode', s.settings.sellMode);
  setVal('set-turnOrder', s.settings.turnOrder);
  setVal('set-turnDirection', s.settings.turnDirection);
  setVal('set-theme', s.settings.theme);
  setVal('set-smallBlind', s.settings.smallBlind);
  setVal('set-teamBudget', s.settings.teamBudget);
  setVal('set-teamSlots', s.settings.teamSlots);
  setVal('set-openingTimeout', s.settings.openingTimeout);
  setVal('set-autoWindow', s.settings.autoWindow);
  setVal('set-soldCooldown', s.settings.soldCooldown);
}

function renderTurnDropdown(s) {
  const sig = (s.captains || []).map((c) => c.id + ':' + c.name).join('|');
  if (sig === turnDropdownSig) return;
  turnDropdownSig = sig;
  const sel = document.getElementById('turn-captain');
  const prev = sel.value;
  sel.innerHTML = (s.captains || []).map((c) => '<option value="' + c.id + '">' + esc(c.name) + '</option>').join('');
  if (prev) sel.value = prev;
}

function renderCaptains(s) {
  const sig = JSON.stringify((s.captains || []).map((c) => [c.id, c.name, c.code, c.price, c.seat, c.maxBid, c.full, c.draftedCount]));
  if (sig === captainsSig) return;
  captainsSig = sig;

  const slots = s.settings.teamSlots;
  let html = '<tr><th>#</th><th>Name</th><th>Code</th><th class="num">Price</th><th class="num">Roster</th><th class="num">Max bid</th><th>Actions</th></tr>';
  for (const c of s.captains || []) {
    html += '<tr>' +
      '<td class="num">' + (c.seat + 1) + '</td>' +
      '<td>' + esc(c.name) + (c.full ? ' <span class="tag full">full</span>' : '') + '</td>' +
      '<td>' + esc(c.code) + '</td>' +
      '<td class="num">$' + c.price + '</td>' +
      '<td class="num">' + c.draftedCount + '/' + slots + '</td>' +
      '<td class="num">$' + c.maxBid + '</td>' +
      '<td class="actions">' +
        '<button class="btn btn-sm" onclick="editCaptain(' + c.id + ')">Edit</button>' +
        '<button class="btn btn-sm" onclick="adminAction(\'turn\',{captainId:' + c.id + '})">Set turn</button>' +
        '<button class="btn btn-sm btn-danger" onclick="deleteCaptain(' + c.id + ')">Del</button>' +
      '</td></tr>';
  }
  document.getElementById('captains-tbl').innerHTML = html;
}

function renderPlayers() {
  const s = STATE;
  if (!s) return;
  const filter = val('player-filter') || 'all';
  let players = s.players || [];
  if (filter === 'open') players = players.filter((p) => p.status === 'open');
  if (filter === 'sold') players = players.filter((p) => p.status === 'sold');

  const sig = filter + '|' + JSON.stringify((s.players || []).map((p) => [p.id, p.name, p.role, p.status, p.captainName, p.price]));
  if (sig === playersSig) return;
  playersSig = sig;

  document.getElementById('player-count').textContent =
    (s.players || []).length + ' total · ' + (s.players || []).filter((p) => p.status === 'open').length + ' open';

  let html = '<tr><th>Name</th><th>Role</th><th>Status</th><th>Team</th><th class="num">Price</th><th>Actions</th></tr>';
  for (const p of players) {
    const isSold = p.status === 'sold';
    html += '<tr>' +
      '<td>' + esc(p.name) + '</td>' +
      '<td>' + esc(p.role || '—') + '</td>' +
      '<td><span class="tag ' + p.status + '">' + p.status + '</span></td>' +
      '<td>' + esc(p.captainName || '—') + '</td>' +
      '<td class="num">' + (isSold ? '$' + p.price : '—') + '</td>' +
      '<td class="actions">' +
        '<button class="btn btn-sm" onclick="editPlayer(' + p.id + ')">Edit</button>' +
        (isSold
          ? '<button class="btn btn-sm" onclick="editPrice(' + p.id + ')">Price</button>' +
            '<button class="btn btn-sm" onclick="removeFromTeam(' + p.id + ')">Unassign</button>'
          : '<button class="btn btn-sm" onclick="assignPlayer(' + p.id + ')">Assign</button>') +
        '<button class="btn btn-sm btn-danger" onclick="deletePlayer(' + p.id + ')">Del</button>' +
      '</td></tr>';
  }
  document.getElementById('players-tbl').innerHTML = html;
}

function setConn(cls, text) {
  const el = document.getElementById('conn');
  if (el) { el.className = 'conn ' + cls; el.textContent = text; }
}

function onAdminState(state) {
  if (state && state.unauthorized) { location.href = '/admin'; return; }
  STATE = state;
  setConn('live', 'live');
  renderStatus(state);
  fillSettingsOnce(state);
  renderTurnDropdown(state);
  renderCaptains(state);
  renderPlayers();
}

connectState('?view=admin', onAdminState);
