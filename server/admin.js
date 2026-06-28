/**
 * Admin console: auth (single password + signed cookie) and the admin action handlers.
 * NOTE: stub — fleshed out in the admin step. For now it only serves a placeholder so the
 * app boots.
 */

function registerAdminRoutes(app) {
  app.get('/admin', (req, res) => {
    res.type('html').send('<p style="font-family:sans-serif">Admin console — coming soon.</p>');
  });
}

module.exports = { registerAdminRoutes };
