/**
 * Admin console: single-password login (signed-by-HMAC token in an httpOnly cookie) and
 * the gated admin action endpoints. Handlers live in adminActions.js; this file is just
 * routing + auth.
 */

const { fontUrlForTheme, ROLE_LABELS } = require('./config');
const { state } = require('./state');
const { checkAdminPassword, makeAdminToken, isValidAdminToken } = require('./auth');
const payload = require('./payload');
const A = require('./adminActions');

const COOKIE = 'admin_token';
const COOKIE_OPTS = { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 12 * 60 * 60 * 1000 };

function isAdmin(req) {
  return isValidAdminToken(req.cookies && req.cookies[COOKIE]);
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  next();
}

function registerAdminRoutes(app) {
  // ----- pages -----
  app.get('/admin', (req, res) => {
    const view = isAdmin(req) ? 'admin' : 'admin-login';
    res.render(view, {
      theme: state.settings.theme,
      fontUrl: fontUrlForTheme(state.settings.theme),
      roleLabels: ROLE_LABELS,
      error: null,
    });
  });

  app.post('/admin/login', (req, res) => {
    if (checkAdminPassword((req.body && req.body.password) || '')) {
      res.cookie(COOKIE, makeAdminToken(), COOKIE_OPTS);
      return res.redirect('/admin');
    }
    res.status(401).render('admin-login', {
      theme: state.settings.theme,
      fontUrl: fontUrlForTheme(state.settings.theme),
      error: 'Wrong password.',
    });
  });

  app.post('/admin/logout', (req, res) => {
    res.clearCookie(COOKIE, { path: '/' });
    res.redirect('/admin');
  });

  // ----- state (initial load / fallback; live updates come over the WS admin channel) -----
  app.get('/api/admin/state', requireAdmin, (req, res) => res.json(payload.buildAdminState()));

  // ----- actions -----
  const post = (path, fn) => app.post('/api/admin/' + path, requireAdmin, (req, res) => res.json(fn(req.body || {})));

  // auction control
  post('start',         () => A.startAuction());
  post('skip',          () => A.skipTurn());
  post('open-bidding',  () => A.openBidding());
  post('close-bidding', () => A.closeBidding());
  post('open-opening',  () => A.openOpeningBid());
  post('sold',          () => A.sold());
  post('empty-teams',   () => A.emptyTeams());
  post('status',        (b) => A.setStatus(b.status));

  // settings
  post('settings',      (b) => A.updateSettings(b.patch || b));

  // captains
  post('captain/add',    (b) => A.addCaptain(b));
  post('captain/update', (b) => A.updateCaptain(b.id, b.patch || {}));
  post('captain/delete', (b) => A.deleteCaptain(b.id));
  post('captain/import', (b) => A.importCaptains(b.text, b.mode));

  // players
  post('player/add',    (b) => A.addPlayer(b));
  post('player/update', (b) => A.updatePlayer(b.id, b.patch || {}));
  post('player/delete', (b) => A.deletePlayer(b.id));
  post('import',        (b) => A.importPlayers(b.text, b.mode));
  post('pool/clear',    () => A.clearPool());

  // manual roster editing
  post('roster/assign', (b) => A.assignPlayerToTeam(b.playerId, b.captainId, b.price));
  post('roster/remove', (b) => A.removePlayerFromTeam(b.playerId));
  post('roster/price',  (b) => A.setPlayerPrice(b.playerId, b.price));
}

module.exports = { registerAdminRoutes };
