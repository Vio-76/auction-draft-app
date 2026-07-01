/**
 * Express routes: page renders (captain page, spectator board) and the captain action
 * endpoints (POST, returning { ok, error } like the old Apps Script handlers). Admin
 * routes are mounted separately (admin.js).
 */

const path = require('node:path');
const fs = require('node:fs');
const { state, captainByName } = require('./state');
const { CAPTAIN_LINKS, ROLE_LABELS, fontUrlForTheme } = require('./config');
const { checkCode, makeCaptainToken, isValidCaptainToken } = require('./auth');
const payload = require('./payload');
const bids = require('./logic/bids');

// Captain session cookie (mirrors the admin cookie in admin.js). Keyed per-captain-id so
// several captains can be signed in from one browser (e.g. during a dry run).
const capCookie = (id) => 'captain_token_' + id;
const CAP_COOKIE_OPTS = { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 7 * 24 * 60 * 60 * 1000 };

function iconExists(key) {
  return fs.existsSync(path.join(__dirname, '..', 'public', 'icons', key + '.png'));
}
function rolesJson() {
  return JSON.stringify(ROLE_LABELS.map((r) => ({
    key: r.toLowerCase(), label: r, hasIcon: iconExists(r.toLowerCase()),
  })));
}

function registerRoutes(app) {
  // ----- spectator board -----
  app.get('/board', (req, res) => {
    res.render('board', {
      theme: state.settings.theme,
      fontUrl: fontUrlForTheme(state.settings.theme),
      rolesJson: rolesJson(),
      infoSections: payload.buildInfoSections(),
    });
  });

  // ----- captain page -----
  app.get('/', (req, res) => {
    const captain = (req.query.captain || '').trim();
    const code = (req.query.code || '').trim();
    const boardUrl = '/board';
    const cap = captainByName(captain);

    // Invite link: validate the code once, set the session cookie, then redirect to a clean
    // URL so the secret never lingers in the address bar (the captain page is safe to stream).
    if (code && cap && checkCode(captain, code)) {
      res.cookie(capCookie(cap.id), makeCaptainToken(cap), CAP_COOKIE_OPTS);
      return res.redirect('/?captain=' + encodeURIComponent(captain));
    }

    const token = cap && req.cookies ? req.cookies[capCookie(cap.id)] : '';
    res.render('captain', {
      captain,
      authorized: isValidCaptainToken(captain, token),
      theme: state.settings.theme,
      fontUrl: fontUrlForTheme(state.settings.theme),
      infoSections: payload.buildInfoSections(),
      extraLinks: CAPTAIN_LINKS,
      boardUrl,
      openingTimeout: state.settings.openingTimeout,
    });
  });

  // ----- captain actions -----
  // Resolve + auth the captain (via the session cookie), then delegate to the bids logic.
  function withCaptain(req, res, fn) {
    const { captain } = req.body || {};
    const cap = captainByName(captain);
    if (!cap) return res.json({ ok: false, error: 'Unknown captain.' });
    const token = req.cookies ? req.cookies[capCookie(cap.id)] : '';
    if (!isValidCaptainToken(cap.name, token)) return res.json({ ok: false, error: 'Unauthorized.' });
    return res.json(fn(cap));
  }

  app.post('/api/bid', (req, res) => withCaptain(req, res, (cap) => bids.placeBid(cap, req.body.amount)));
  app.post('/api/opening-bid', (req, res) => withCaptain(req, res, (cap) => bids.placeOpeningBid(cap, req.body.player, req.body.amount)));
  app.post('/api/skip', (req, res) => withCaptain(req, res, (cap) => bids.skipTurn(cap)));
}

module.exports = { registerRoutes };
