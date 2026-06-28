/* Shared client helpers, loaded as a normal static script by both pages. (The old
   String.fromCharCode workaround is gone — that was only needed because the Apps Script
   include() pipeline HTML-escaped a literal "<". A real .js file has no such problem.) */

function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// Collapsible Rules/Info panel.
function toggleInfo(btn) {
  const open = btn.getAttribute('aria-expanded') === 'true';
  btn.setAttribute('aria-expanded', String(!open));
  const body = btn.parentNode.querySelector('.info-body');
  if (body) body.hidden = open;
}

/**
 * Opens a reconnecting WebSocket to /ws with the given query string (e.g. "?view=board"
 * or "?captain=Foo&code=bar"). Calls onState(state) for every pushed payload. Auto-
 * reconnects with backoff; resubscribes on focus. Returns nothing — fire and forget.
 */
function connectState(query, onState) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = proto + '//' + location.host + '/ws' + (query || '');
  let ws = null;
  let backoff = 500;
  let closedByUs = false;

  function open() {
    ws = new WebSocket(url);
    ws.onmessage = function (ev) {
      backoff = 500;
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg && msg.state) onState(msg.state);
    };
    ws.onclose = function () {
      if (closedByUs) return;
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 8000);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  // If the socket somehow dropped while hidden, reopen on focus.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && (!ws || ws.readyState === WebSocket.CLOSED)) open();
  });

  open();
}

/** Copies text to the clipboard; returns true on success. Falls back to a hidden textarea
 *  + execCommand for non-secure contexts where navigator.clipboard is unavailable. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) {
    return false;
  }
}

/** POSTs JSON and resolves to the parsed { ok, error, ... } response. */
async function postJson(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return await res.json();
  } catch (err) {
    return { ok: false, error: 'Network error.' };
  }
}
