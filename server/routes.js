/**
 * Express routes: page renders (captain page, spectator board) and the captain action
 * endpoints (POST, returning { ok, error } like the old Apps Script handlers). Admin
 * routes are mounted separately (admin.js).
 */

const path = require('node:path');
const fs = require('node:fs');
const { state, captainByName } = require('./state');
const { CAPTAIN_LINKS, ROLE_LABELS, fontUrlForTheme } = require('./config');
const { checkCode } = require('./auth');
const payload = require('./payload');
const bids = require('./logic/bids');

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
    res.render('captain', {
      captain,
      code,
      authorized: checkCode(captain, code),
      theme: state.settings.theme,
      fontUrl: fontUrlForTheme(state.settings.theme),
      infoSections: payload.buildInfoSections(),
      extraLinks: CAPTAIN_LINKS,
      boardUrl,
      openingTimeout: state.settings.openingTimeout,
    });
  });

  // ----- captain actions -----
  // Resolve + auth the captain, then delegate to the synchronous bids logic.
  function withCaptain(req, res, fn) {
    const { captain, code } = req.body || {};
    if (!checkCode(captain, code)) return res.json({ ok: false, error: 'Unauthorized.' });
    const cap = captainByName(captain);
    if (!cap) return res.json({ ok: false, error: 'Unknown captain.' });
    return res.json(fn(cap));
  }

  app.post('/api/bid', (req, res) => withCaptain(req, res, (cap) => bids.placeBid(cap, req.body.amount)));
  app.post('/api/opening-bid', (req, res) => withCaptain(req, res, (cap) => bids.placeOpeningBid(cap, req.body.player, req.body.amount)));
  app.post('/api/skip', (req, res) => withCaptain(req, res, (cap) => bids.skipTurn(cap)));
}

module.exports = { registerRoutes };
