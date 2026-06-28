/**
 * WebSocket hub. Replaces the old 1s/3s polling of getState/getBoardState. On connect a
 * client declares itself a captain (?captain=NAME&code=CODE) or the board (?view=board);
 * we send the initial payload, then re-push to everyone whenever state changes (bus
 * 'changed'). Changes within the same tick are coalesced into one broadcast.
 */

const { WebSocketServer } = require('ws');
const { URL } = require('node:url');
const { bus } = require('./bus');
const { checkCode, isValidAdminToken } = require('./auth');
const { captainByName } = require('./state');
const payload = require('./payload');

const clients = new Set();

/** Minimal cookie header parser -> { name: value }. */
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function payloadFor(ws) {
  if (ws.kind === 'board') {
    return { type: 'board', state: payload.buildBoardState() };
  }
  if (ws.kind === 'admin') {
    if (!ws.authed) return { type: 'admin', state: { unauthorized: true } };
    return { type: 'admin', state: payload.buildAdminState() };
  }
  // captain
  if (!ws.authed) return { type: 'captain', state: { unauthorized: true } };
  const cap = captainByName(ws.captainName);
  if (!cap) return { type: 'captain', state: { unauthorized: true } };
  return { type: 'captain', state: payload.buildCaptainState(cap) };
}

function send(ws) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(payloadFor(ws)));
  } catch { /* client went away mid-send */ }
}

function broadcast() {
  for (const ws of clients) send(ws);
}

function init(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    let q;
    try {
      q = new URL(req.url, 'http://localhost').searchParams;
    } catch {
      q = new URLSearchParams();
    }

    const view = q.get('view') || '';
    if (view === 'board') {
      ws.kind = 'board';
    } else if (view === 'admin') {
      ws.kind = 'admin';
      const cookies = parseCookies(req.headers.cookie);
      ws.authed = isValidAdminToken(cookies.admin_token);
    } else {
      const name = (q.get('captain') || '').trim();
      const code = (q.get('code') || '').trim();
      ws.kind = 'captain';
      ws.captainName = name;
      ws.authed = checkCode(name, code);
    }

    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    send(ws); // initial snapshot
  });

  // Coalesce same-tick changes into a single broadcast.
  let scheduled = false;
  bus.on('changed', () => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => { scheduled = false; broadcast(); });
  });
}

module.exports = { init, broadcast };
