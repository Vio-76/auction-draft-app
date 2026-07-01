# Auction Draft

A live, real-time **auction draft** web app. Captains bid on players to fill their
teams; an admin runs the auction; spectators watch a public team board. All in real
time over WebSockets.

This is a standalone successor to a Google Apps Script + Google Sheet version — the
sheet is replaced by a Node backend with a SQLite database and a real admin console.

## Stack

- **Backend:** Node.js + Express
- **Realtime:** WebSockets (`ws`) — server pushes state; no polling
- **Storage:** SQLite via Node's built-in `node:sqlite` (synchronous, no native build)
- **Frontend:** plain HTML/CSS/vanilla JS, server-rendered with EJS
- **Auth:** captains sign in via a one-time invite link that sets a session cookie — no
  secret stays in the URL, so the captain page is safe to screen-share; the admin console
  uses a single password

## Surfaces

- **Captain page** — open your invite link once (`/?captain=NAME&code=CODE`); it sets a
  session cookie and redirects to a clean `/?captain=NAME` with no secret in the URL. Pick a
  player and place an opening bid on your turn, then bid against everyone until the player is sold.
- **Spectator board** — `/board`: read-only grid of every team, a live "on the block"
  bid banner (with an AUTO-mode countdown), the player pool, and the opening-bid turn order.
- **Admin console** — `/admin`: manage players/captains (incl. bulk paste-import and
  captain turn order), control the auction (start, pause, empty teams, skip turn, set
  phase, sell), edit rosters live, tune settings, and toggle whether the live bid is
  shown publicly on the board.

## Running locally

```sh
npm install
cp .env.example .env   # then edit ADMIN_PASSWORD and SESSION_SECRET
npm start              # http://localhost:3000
```

Requires Node 22.5+ (for built-in `node:sqlite`). `DB_PATH` optionally overrides where the
SQLite file lives (defaults to `./auction.db`); leave it unset for local development.

## Deployment

The app runs as a **single** long-lived Node process — the in-memory state is the source of
truth, so it must **not** be horizontally scaled — with the SQLite file on persistent storage.
It's hosted on **[Render](https://render.com)** as one web-service instance with a persistent
disk, and `DB_PATH` points the database at that disk. Any host works that provides Node 22.5+,
a persistent filesystem, WebSockets, HTTPS, and a single instance.

Environment variables:

- `PORT` — listen port (provided automatically by most hosts).
- `ADMIN_PASSWORD` — password for the admin console.
- `SESSION_SECRET` — long random string; signs the admin and captain session cookies.
- `DB_PATH` — path to the SQLite file on the persistent disk (e.g. a mounted volume).

## Auction flow

A turn marker rotates through captains (waterfall or snake order):

1. **OPENING** — the turn-holder has a countdown to pick an available player and place
   an opening bid (or skip). Timing out auto-skips to the next captain.
2. **BIDDING** — open to all captains until the player is sold: in **MANUAL** mode the
   admin clicks **Sell player**; in **AUTO** mode the server sells to the high bidder after
   a no-new-bid countdown. An uncontestable bid (no one else can outbid) sells immediately.
   The player goes to the highest bidder and the turn advances.

State lives in SQLite and is mirrored by an in-memory object at runtime, so the
auction survives a server restart.
