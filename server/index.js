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

load();

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser(process.env.SESSION_SECRET || 'dev-secret-change-me'));
app.use('/static', express.static(path.join(__dirname, '..', 'public')));

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
