/**
 * App bootstrap: load state from SQLite, wire Express (page renders + captain/admin
 * actions), attach the WebSocket hub, and start the server heartbeat (timers).
 */

const express = require('express');
const http = require('node:http');
const path = require('node:path');
const cookieParser = require('cookie-parser');

const { load } = require('./state');
const ws = require('./ws');
const timers = require('./timers');
const { registerRoutes } = require('./routes');
const { registerAdminRoutes } = require('./admin');
const { UPLOADS_DIR } = require('./uploads');

load();

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
// 8mb so a ~3MB player image (~4MB as base64) fits in the JSON upload body. Admin routes are
// password-gated, so this bigger limit isn't publicly reachable for the write endpoints.
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser(process.env.SESSION_SECRET || 'dev-secret-change-me'));
app.use('/static', express.static(path.join(__dirname, '..', 'public')));
// Uploaded player images (served read-only). Dir is derived from DB_PATH, so this is the
// repo-root ./uploads locally and /data/uploads on Render — same code path both places.
app.use('/uploads', express.static(UPLOADS_DIR));

registerRoutes(app);
registerAdminRoutes(app);

const server = http.createServer(app);
ws.init(server);
timers.start();

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => {
  console.log(`Auction app listening on http://localhost:${PORT}`);
  console.log(`  captain:   http://localhost:${PORT}/?captain=NAME&code=CODE`);
  console.log(`  board:     http://localhost:${PORT}/board`);
  console.log(`  admin:     http://localhost:${PORT}/admin`);
});
