/* Admin console client. Live state arrives over the WS admin channel; actions are fetch
   POSTs to /api/admin/*. Edits use in-page <dialog> modals (not native prompt/confirm,
   which are blocked in embedded browsers like VS Code's Simple Browser or when streamed
   in some webviews). esc()/connectState()/postJson() come from shared.js;
   window.ROLE_LABELS is injected by admin.ejs. */

let STATE = null;
let settingsInitialized = false;
let captainsSig = '';
let playersSig = '';

// ----- modal helpers (replace prompt/confirm/alert) -----

/** Reads a File into a base64 data URL (used by the modal's file fields). */
function readFileAsDataUrl(file) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = function () { resolve(r.result); };
    r.onerror = function () { resolve(''); };
    r.readAsDataURL(file);
  });
}

/** Opens a form modal. `fields`: [{name,label,type:'text'|'number'|'select'|'file',value,options,accept}].
 *  A 'file' field resolves to a base64 data URL (or '' if none chosen); `value` on a file field is
 *  treated as a current-image URL and shown as a thumbnail. Resolves to { name: value } or null. */
function openModal(opts) {
  const fields = opts.fields || [];
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'modal';
    let html = '<form class="modal-form"><h3 class="modal-title">' + esc(opts.title || '') + '</h3><div class="modal-fields">';
    for (const f of fields) {
      const id = 'm_' + f.name;
      html += '<label>' + esc(f.label);
      if (f.type === 'select') {
        html += '<select id="' + id + '">' + (f.options || []).map(function (o) {
          const sel = String(o.value) === String(f.value != null ? f.value : '') ? ' selected' : '';
          return '<option value="' + esc(String(o.value)) + '"' + sel + '>' + esc(o.label) + '</option>';
        }).join('') + '</select>';
      } else if (f.type === 'file') {
        if (f.value) html += '<img class="modal-thumb" src="' + esc(String(f.value)) + '" alt="current image">';
        html += '<input id="' + id + '" type="file"' + (f.accept ? ' accept="' + esc(f.accept) + '"' : '') + '>';
      } else {
        const step = f.type === 'number' ? ' step="1"' : '';
        html += '<input id="' + id + '" type="' + (f.type || 'text') + '" value="' + esc(f.value != null ? String(f.value) : '') + '"' + step + '>';
      }
      html += '</label>';
    }
    html += '</div><div class="modal-actions"><button type="button" class="btn btn-ghost" data-cancel>Cancel</button>' +
      '<button type="submit" class="btn btn-accent">' + esc(opts.submitLabel || 'Save') + '</button></div></form>';
    dlg.innerHTML = html;
    document.body.appendChild(dlg);

    function done(result) { try { dlg.close(); } catch (e) {} dlg.remove(); resolve(result); }
    dlg.querySelector('[data-cancel]').onclick = function () { done(null); };
    dlg.querySelector('form').onsubmit = async function (e) {
      e.preventDefault();
      const values = {};
      for (const f of fields) {
        const el = document.getElementById('m_' + f.name);
        if (f.type === 'file') {
          values[f.name] = (el && el.files && el.files[0]) ? await readFileAsDataUrl(el.files[0]) : '';
        } else {
          values[f.name] = el ? el.value : '';
        }
      }
      done(values);
    };
    dlg.addEventListener('cancel', function (e) { e.preventDefault(); done(null); }); // ESC key
    dlg.showModal();
    const first = dlg.querySelector('input, select');
    if (first) first.focus();
  });
}

function confirmModal(message, confirmLabel, danger) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'modal';
    dlg.innerHTML = '<div class="modal-msg">' + esc(message) + '</div><div class="modal-actions">' +
      '<button class="btn btn-ghost" data-cancel>Cancel</button>' +
      '<button class="btn ' + (danger === false ? 'btn-accent' : 'btn-danger') + '" data-ok>' + esc(confirmLabel || 'Confirm') + '</button></div>';
    document.body.appendChild(dlg);
    function done(v) { try { dlg.close(); } catch (e) {} dlg.remove(); resolve(v); }
    dlg.querySelector('[data-cancel]').onclick = function () { done(false); };
    dlg.querySelector('[data-ok]').onclick = function () { done(true); };
    dlg.addEventListener('cancel', function (e) { e.preventDefault(); done(false); });
    dlg.showModal();
  });
}

function alertModal(message) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'modal';
    dlg.innerHTML = '<div class="modal-msg">' + esc(message) + '</div><div class="modal-actions"><button class="btn btn-accent" data-ok>OK</button></div>';
    document.body.appendChild(dlg);
    function done() { try { dlg.close(); } catch (e) {} dlg.remove(); resolve(); }
    dlg.querySelector('[data-ok]').onclick = done;
    dlg.addEventListener('cancel', function (e) { e.preventDefault(); done(); });
    dlg.showModal();
  });
}

function roleOptions(current) {
  const labels = window.ROLE_LABELS || [];
  const opts = [{ value: '', label: '—' }].concat(labels.map((r) => ({ value: r, label: r })));
  if (current && labels.indexOf(current) === -1) opts.push({ value: current, label: current });
  return opts;
}
function teamOptions() {
  return [{ value: '', label: '— choose team —' }].concat((STATE.captains || []).map((c) => ({ value: c.id, label: c.name })));
}

// ----- actions -----

async function adminAction(path, body, confirmMsg) {
  if (confirmMsg && !(await confirmModal(confirmMsg, 'Confirm', false))) return;
  const res = await postJson('/api/admin/' + path, body || {});
  if (!res || !res.ok) await alertModal((res && res.error) || 'Action failed.');
  return res;
}

function saveSettings() {
  const patch = {
    sellMode: val('set-sellMode'), turnOrder: val('set-turnOrder'),
    turnDirection: val('set-turnDirection'), poolOrder: val('set-poolOrder'),
    theme: val('set-theme'),
    showBidOnBoard: val('set-showBidOnBoard') === 'true',
    showBudgetOnBoard: val('set-showBudgetOnBoard') === 'true',
    smallBlind: numVal('set-smallBlind'), teamBudget: numVal('set-teamBudget'),
    teamSlots: numVal('set-teamSlots'), openingTimeout: numVal('set-openingTimeout'),
    autoWindow: numVal('set-autoWindow'), soldCooldown: numVal('set-soldCooldown'),
    openingMessageSeconds: numVal('set-openingMessageSeconds'),
    soldMessageSeconds: numVal('set-soldMessageSeconds'),
  };
  adminAction('settings', { patch });
}


// captains
// Team group (board display once FINISHED): none / Group A / Group B. (Selection is driven by
// the field's `value` in openModal, so this just lists the choices.)
function groupOptions() {
  return [{ value: '', label: '— none —' }, { value: 'A', label: 'A' }, { value: 'B', label: 'B' }];
}
async function addCaptain() {
  const v = await openModal({ title: 'Add captain', submitLabel: 'Add', fields: [
    { name: 'name', label: 'Name', type: 'text', value: '' },
    { name: 'code', label: 'Password', type: 'text', value: '' },
    { name: 'price', label: 'Price', type: 'number', value: 0 },
    { name: 'role', label: 'Role', type: 'select', value: '', options: roleOptions('') },
    { name: 'discord', label: 'Discord name', type: 'text', value: '' },
    { name: 'teamGroup', label: 'Group', type: 'select', value: '', options: groupOptions() },
    { name: 'teamName', label: 'Team name', type: 'text', value: '' },
  ] });
  if (!v || !v.name.trim()) return;
  adminAction('captain/add', { name: v.name, code: v.code, price: Number(v.price) || 0, role: v.role, discord: v.discord, teamGroup: v.teamGroup, teamName: v.teamName });
}
async function editCaptain(id) {
  const c = (STATE.captains || []).find((x) => x.id === id);
  if (!c) return;
  const v = await openModal({ title: 'Edit captain', fields: [
    { name: 'name', label: 'Name', type: 'text', value: c.name },
    { name: 'code', label: 'Password', type: 'text', value: c.code },
    { name: 'price', label: 'Price', type: 'number', value: c.price },
    { name: 'role', label: 'Role', type: 'select', value: c.role, options: roleOptions(c.role) },
    { name: 'discord', label: 'Discord name', type: 'text', value: c.discord || '' },
    { name: 'teamGroup', label: 'Group', type: 'select', value: c.teamGroup || '', options: groupOptions() },
    { name: 'teamName', label: 'Team name', type: 'text', value: c.teamName || '' },
  ] });
  if (!v || !v.name.trim()) return;
  adminAction('captain/update', { id, patch: { name: v.name, code: v.code, price: Number(v.price) || 0, role: v.role, discord: v.discord, teamGroup: v.teamGroup, teamName: v.teamName } });
}
async function importCaptains() {
  const text = val('captain-import-text');
  if (!text.trim()) { await alertModal('Paste a captain list first.'); return; }
  const mode = val('captain-import-mode');
  if (mode === 'replace' &&
      !(await confirmModal('Replace ALL captains? Every existing captain is deleted and their drafted players return to the pool.', 'Replace all'))) return;
  const res = await adminAction('captain/import', { text, mode });
  if (res && res.ok) { document.getElementById('captain-import-text').value = ''; await alertModal('Imported ' + res.added + ' captains.'); }
}
async function deleteCaptain(id) {
  const c = (STATE.captains || []).find((x) => x.id === id);
  if (await confirmModal('Delete captain "' + (c ? c.name : id) + '"? Their drafted players return to the pool.', 'Delete'))
    adminAction('captain/delete', { id });
}
function moveCaptain(id, dir) { adminAction('captain/move', { id, dir }); }
async function copyCaptainLink(id) {
  const c = (STATE.captains || []).find((x) => x.id === id);
  if (!c) return;
  const url = location.origin + '/?captain=' + encodeURIComponent(c.name) + '&code=' + encodeURIComponent(c.code);
  const okCopy = await copyText(url);
  if (okCopy) await alertModal('Copied ' + c.name + "'s invite link to the clipboard.");
  else await alertModal('Could not copy automatically. Full link:\n' + url);
}

// players
const IMG_ACCEPT = 'image/png,image/jpeg,image/webp';
const IMG_HINT = 'JPG/PNG/WebP, under ~500 KB, square-ish, ~800px. Shown when the player gets their opening bid.';

async function addPlayer() {
  const v = await openModal({ title: 'Add player', submitLabel: 'Add', fields: [
    { name: 'name', label: 'Name', type: 'text', value: '' },
    { name: 'role', label: 'Role', type: 'select', value: '', options: roleOptions('') },
    { name: 'discord', label: 'Discord name', type: 'text', value: '' },
    { name: 'image', label: 'Image (optional) — ' + IMG_HINT, type: 'file', accept: IMG_ACCEPT },
  ] });
  if (!v || !v.name.trim()) return;
  const res = await adminAction('player/add', { name: v.name, role: v.role, discord: v.discord });
  if (res && res.ok && res.id && v.image) await adminAction('player/image', { id: res.id, dataUrl: v.image });
}
async function editPlayer(id) {
  const p = (STATE.players || []).find((x) => x.id === id);
  if (!p) return;
  const v = await openModal({ title: 'Edit player', fields: [
    { name: 'name', label: 'Name', type: 'text', value: p.name },
    { name: 'role', label: 'Role', type: 'select', value: p.role, options: roleOptions(p.role) },
    { name: 'discord', label: 'Discord name', type: 'text', value: p.discord || '' },
    { name: 'image', label: (p.image ? 'Replace image' : 'Image') + ' (optional) — ' + IMG_HINT, type: 'file',
      accept: IMG_ACCEPT, value: p.image ? '/uploads/' + p.image : '' },
  ] });
  if (!v || !v.name.trim()) return;
  await adminAction('player/update', { id, patch: { name: v.name, role: v.role, discord: v.discord } });
  if (v.image) await adminAction('player/image', { id, dataUrl: v.image });
}
async function removePlayerImage(id) {
  const p = (STATE.players || []).find((x) => x.id === id);
  if (await confirmModal('Remove the image for "' + (p ? p.name : id) + '"?', 'Remove'))
    adminAction('player/image/clear', { id });
}
async function deletePlayer(id) {
  const p = (STATE.players || []).find((x) => x.id === id);
  if (await confirmModal('Delete player "' + (p ? p.name : id) + '"?', 'Delete'))
    adminAction('player/delete', { id });
}
async function importPlayers() {
  const text = val('import-text');
  if (!text.trim()) { await alertModal('Paste a player list first.'); return; }
  const mode = val('import-mode');
  if (mode === 'replace' &&
      !(await confirmModal('Replace the open player pool? Every undrafted player is removed before importing (drafted players are kept).', 'Replace pool'))) return;
  const res = await adminAction('import', { text, mode });
  if (res && res.ok) { document.getElementById('import-text').value = ''; await alertModal('Imported ' + res.added + ' players.'); }
}

// team export string
async function copyTeamString() {
  const text = val('team-string');
  if (!text) { await alertModal('No teams yet.'); return; }
  if (await copyText(text)) await alertModal('Copied the team string to the clipboard.');
  else await alertModal('Could not copy automatically. Team string:\n' + text);
}

// roster editing
async function assignPlayer(id) {
  const p = (STATE.players || []).find((x) => x.id === id);
  if (!p) return;
  const v = await openModal({ title: 'Assign ' + p.name + ' to a team', submitLabel: 'Assign', fields: [
    { name: 'captainId', label: 'Team', type: 'select', value: '', options: teamOptions() },
    { name: 'price', label: 'Price', type: 'number', value: 0 },
  ] });
  if (!v || !v.captainId) return;
  adminAction('roster/assign', { playerId: id, captainId: Number(v.captainId), price: Number(v.price) || 0 });
}
async function reassign(id) {
  const p = (STATE.players || []).find((x) => x.id === id);
  if (!p) return;
  const v = await openModal({ title: 'Edit ' + p.name + ' — team & price', fields: [
    { name: 'captainId', label: 'Team', type: 'select', value: String(p.captainId), options: teamOptions() },
    { name: 'price', label: 'Price', type: 'number', value: p.price },
  ] });
  if (!v || !v.captainId) return;
  adminAction('roster/assign', { playerId: id, captainId: Number(v.captainId), price: Number(v.price) || 0 });
}
function removeFromTeam(id) { adminAction('roster/remove', { playerId: id }); }

// captain password reveal (masked by default so the page is safe to stream)
function revealCode(el) {
  if (el.dataset.shown === '1') { el.textContent = '••••'; el.dataset.shown = '0'; }
  else { el.textContent = el.dataset.code || '(none)'; el.dataset.shown = '1'; }
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
  let html = cells.map(function (c) {
    return '<div class="stat"><span class="k">' + c[0] + '</span><span class="v">' + c[1] + '</span></div>';
  }).join('');

  // Live countdown next to the order info: opening-turn timer, the AUTO auto-sell timer, or
  // — while paused — the snapshot of how much was left when the admin hit Pause.
  let cdLabel = '', cdVal = '', urgent = false;
  if (s.openingSecondsRemaining != null) {
    cdLabel = 'Opening turn'; cdVal = s.openingSecondsRemaining + 's'; urgent = s.openingSecondsRemaining <= 10;
  } else if (s.autoSellSecondsRemaining != null) {
    cdLabel = 'Auto-sell in'; cdVal = s.autoSellSecondsRemaining + 's'; urgent = s.autoSellSecondsRemaining <= 5;
  } else if (s.pausedRemaining) {
    cdLabel = s.pausedRemaining.kind === 'opening' ? 'Paused — opening left' : 'Paused — auto-sell left';
    cdVal = s.pausedRemaining.seconds + 's';
  }
  if (cdVal) {
    html += '<div class="stat"><span class="k">' + cdLabel + '</span>' +
      '<span class="countdown' + (urgent ? ' urgent' : '') + '">' + cdVal + '</span></div>';
  }
  document.getElementById('status-bar').innerHTML = html;

  const soldBtn = document.getElementById('sold-btn');
  if (soldBtn) soldBtn.disabled = !s.soldArmed;
}

function fillSettingsOnce(s) {
  if (settingsInitialized) return;
  settingsInitialized = true;
  setVal('set-sellMode', s.settings.sellMode);
  setVal('set-turnOrder', s.settings.turnOrder);
  setVal('set-turnDirection', s.settings.turnDirection);
  setVal('set-poolOrder', s.settings.poolOrder);
  setVal('set-theme', s.settings.theme);
  setVal('set-showBidOnBoard', String(s.settings.showBidOnBoard));
  setVal('set-showBudgetOnBoard', String(s.settings.showBudgetOnBoard));
  setVal('set-smallBlind', s.settings.smallBlind);
  setVal('set-teamBudget', s.settings.teamBudget);
  setVal('set-teamSlots', s.settings.teamSlots);
  setVal('set-openingTimeout', s.settings.openingTimeout);
  setVal('set-autoWindow', s.settings.autoWindow);
  setVal('set-soldCooldown', s.settings.soldCooldown);
  setVal('set-openingMessageSeconds', s.settings.openingMessageSeconds);
  setVal('set-soldMessageSeconds', s.settings.soldMessageSeconds);
}

function renderCaptains(s) {
  const sig = JSON.stringify((s.captains || []).map((c) => [c.id, c.name, c.code, c.price, c.role, c.seat, c.discord, c.teamGroup, c.teamName, c.maxBid, c.full, c.draftedCount]));
  if (sig === captainsSig) return;
  captainsSig = sig;

  const slots = s.settings.teamSlots;
  const caps = s.captains || [];
  let html = '<tr><th>#</th><th>Name</th><th>Role</th><th>Discord</th><th>Group</th><th>Team name</th><th>Password</th><th>Invite link</th><th class="num">Price</th><th class="num">Roster</th><th class="num">Max bid</th><th>Order</th><th>Actions</th></tr>';
  caps.forEach(function (c, i) {
    html += '<tr>' +
      '<td class="num">' + (c.seat + 1) + '</td>' +
      '<td>' + esc(c.name) + (c.full ? ' <span class="tag full">full</span>' : '') + '</td>' +
      '<td>' + esc(c.role || '—') + '</td>' +
      '<td>' + esc(c.discord || '—') + '</td>' +
      '<td>' + esc(c.teamGroup || '—') + '</td>' +
      '<td>' + esc(c.teamName || '—') + '</td>' +
      '<td><span class="code" data-code="' + esc(c.code) + '" data-shown="0" onclick="revealCode(this)" title="Click to reveal / hide">••••</span></td>' +
      '<td><span class="copylink" onclick="copyCaptainLink(' + c.id + ')" title="Click to copy the full invite link (password stays hidden on screen)">?captain=' + esc(c.name) + ' 🔗</span></td>' +
      '<td class="num">$' + c.price + '</td>' +
      '<td class="num">' + c.draftedCount + '/' + slots + '</td>' +
      '<td class="num">$' + c.maxBid + '</td>' +
      '<td><div class="ord-btns">' +
        '<button class="btn btn-sm" onclick="moveCaptain(' + c.id + ',\'up\')"' + (i === 0 ? ' disabled' : '') + ' title="Move up">↑</button>' +
        '<button class="btn btn-sm" onclick="moveCaptain(' + c.id + ',\'down\')"' + (i === caps.length - 1 ? ' disabled' : '') + ' title="Move down">↓</button>' +
      '</div></td>' +
      '<td class="actions">' +
        '<button class="btn btn-sm" onclick="editCaptain(' + c.id + ')">Edit</button>' +
        '<button class="btn btn-sm btn-danger" onclick="deleteCaptain(' + c.id + ')">Del</button>' +
      '</td></tr>';
  });
  document.getElementById('captains-tbl').innerHTML = html;
}

function renderPlayers() {
  const s = STATE;
  if (!s) return;
  const filter = val('player-filter') || 'all';
  let players = (s.players || []).slice();   // copy so the sort doesn't mutate STATE
  if (filter === 'open') players = players.filter((p) => p.status === 'open');
  if (filter === 'sold') players = players.filter((p) => p.status === 'sold');
  players.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const sig = filter + '|' + JSON.stringify((s.players || []).map((p) => [p.id, p.name, p.role, p.status, p.captainName, p.price, p.discord, p.image]));
  if (sig === playersSig) return;
  playersSig = sig;

  document.getElementById('player-count').textContent =
    (s.players || []).length + ' total · ' + (s.players || []).filter((p) => p.status === 'open').length + ' open';

  let html = '<tr><th>Img</th><th>Name</th><th>Role</th><th>Discord</th><th>Status</th><th>Team</th><th class="num">Price</th><th>Actions</th></tr>';
  for (const p of players) {
    const isSold = p.status === 'sold';
    const imgCell = p.image
      ? '<img class="tbl-thumb" src="/uploads/' + esc(p.image) + '" alt="" title="' + esc(p.name) + '">'
      : '<span class="tbl-thumb tbl-thumb-empty">—</span>';
    html += '<tr>' +
      '<td>' + imgCell + '</td>' +
      '<td>' + esc(p.name) + '</td>' +
      '<td>' + esc(p.role || '—') + '</td>' +
      '<td>' + esc(p.discord || '—') + '</td>' +
      '<td><span class="tag ' + p.status + '">' + p.status + '</span></td>' +
      '<td>' + esc(p.captainName || '—') + '</td>' +
      '<td class="num">' + (isSold ? '$' + p.price : '—') + '</td>' +
      '<td class="actions">' +
        '<button class="btn btn-sm" onclick="editPlayer(' + p.id + ')">Edit</button>' +
        (p.image ? '<button class="btn btn-sm" onclick="removePlayerImage(' + p.id + ')">Rmv img</button>' : '') +
        (isSold
          ? '<button class="btn btn-sm" onclick="reassign(' + p.id + ')">Team/price</button>' +
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

function renderTeamString(s) {
  const el = document.getElementById('team-string');
  if (!el) return;
  const v = s.teamString || '';
  if (el.value !== v) el.value = v;   // only rewrite on change (don't clobber a selection)
}

function onAdminState(state) {
  if (state && state.unauthorized) { location.href = '/admin'; return; }
  STATE = state;
  setConn('live', 'live');
  renderStatus(state);
  fillSettingsOnce(state);
  renderCaptains(state);
  renderPlayers();
  renderTeamString(state);
}

connectState('?view=admin', onAdminState);
