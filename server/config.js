/**
 * Tunable constants and defaults. Ported from the Apps Script Config.js, minus every
 * sheet-cell address — state now lives in SQLite (see db.js / state.js), and live
 * tunables (timeouts, budget, small blind, sell mode, turn order, theme) are editable
 * from the admin console and stored in the `settings` table. The values here are only
 * the FALLBACK defaults used to seed a fresh database.
 */

// ----- Status / mode enums (stored as these exact strings) -----
const STATUS = { OPENING: 'OPENING', BIDDING: 'BIDDING', CLOSED: 'CLOSED', FINISHED: 'FINISHED' };
const SELL_MODE = { AUTO: 'AUTO', MANUAL: 'MANUAL' };
const TURN_ORDER = { WATERFALL: 'WATERFALL', SNAKE: 'SNAKE' };
const TURN_DIR = { DOWN: 1, UP: -1 };          // numeric for the walker; serialized as DOWN/UP
const POOL_ORDER = { RANDOM: 'RANDOM', ALPHABETICAL: 'ALPHABETICAL' };   // spectator-board open-pool ordering

const PLAYER_STATUS = { OPEN: 'open', SOLD: 'sold' };

// ----- Default settings used to seed an empty database -----
const DEFAULT_SETTINGS = {
  status:             STATUS.CLOSED,
  sellMode:           SELL_MODE.AUTO,
  turnOrder:          TURN_ORDER.WATERFALL,
  turnDirection:      TURN_DIR.DOWN,
  poolOrder:          POOL_ORDER.RANDOM,       // spectator-board open pool: RANDOM (seeded shuffle) or ALPHABETICAL
  smallBlind:         5,
  teamBudget:         100,
  teamSlots:          4,           // drafted players per team, excluding the captain
  openingTimeout:     30,          // seconds for the turn-holder to open
  autoWindow:         20,          // AUTO mode: seconds with no new bid before auto-sell
  soldCooldown:       3,           // seconds the Sold action is blocked after each bid
  soldMessageSeconds: 5,           // how long the "sold" banner owns the screen before the next opening UI
  openingMessageSeconds: 5,        // how long the opening-bid announcement (with player image) shows
  marker:             -1,          // current turn index into captains (seat order); -1 = none
  theme:              'draftroom',
  showBidOnBoard:     true,        // show the live bid (player/amount/bidder) on the public board
  showBudgetOnBoard:  true,        // show the per-team available-budget bar on the board team cards
};

// ----- Roles (board grouping + per-team role flags) -----
// Order matters: it's the display order of the role flags / pool columns.
const ROLE_LABELS = ['Top', 'Jungle', 'Mid', 'ADC', 'Support', 'Fill'];

// Spectator-board pool ordering: deterministic shuffle seed (looks random, stable per name).
const PLAYER_SHUFFLE_SEED = 'neme-2026';

// ----- op.gg multi-search (shown per team on the board once the auction is FINISHED) -----
// Region is fixed here rather than a live setting; change it once if you run a non-EUW draft.
const OPGG_REGION = 'euw';
const OPGG_MULTISEARCH_BASE = 'https://op.gg/lol/multisearch';

// ----- Captain page theme -----
// "draftroom" | "auctionhouse" | "terminal" | "broadcast" | "brutalist" | "casino"
// (Stored per-auction in settings.theme; this is just the seed default.)
const THEME_FONT_URLS = {
  draftroom:    'https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap',
  auctionhouse: 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=Outfit:wght@300;400;500;600&display=swap',
  terminal:     'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700;800&display=swap',
  broadcast:    'https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wght@400;500;600;700;800;900&display=swap',
  brutalist:    'https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;800;900&family=JetBrains+Mono:wght@500;700&display=swap',
  casino:       'https://fonts.googleapis.com/css2?family=Bungee&family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap',
};

function fontUrlForTheme(theme) {
  return THEME_FONT_URLS[theme] || THEME_FONT_URLS.draftroom;
}

// ----- Rules & info panel (captain page + spectator board) -----
// Same author copy + token system as the Apps Script version. Tokens filled at render
// time by buildInfoSections() (see payload.js): {OPENING_SECONDS} {AUTO_SECONDS}
// {SMALL_BLIND} {TEAM_BUDGET} {NUM_CAPTAINS} {TURN_ORDER} {SELL_MODE}.
// *term* marks an emphasized keyword.
const AUCTION_INFO_SECTIONS = [
  {
    heading: 'Bidding phase',
    items: [
      'When a player is on the block, any captain can place a bid.',
      'A new bid must beat the current bid by at least $1.',
      'The *max bid* of a captain is the highest amount they can bid on a player. (It is calculated from the total team budget ${TEAM_BUDGET}, the minimum player cost ${SMALL_BLIND} and the costs of players already in the team.)',
      'A captain can not bid if the current bid exceeds their max bid or their team is full.',
      '{SELL_MODE}',
    ],
  },
  {
    heading: 'Opening bid phase',
    items: [
      'When it is a captains *turn* they have {OPENING_SECONDS}seconds to pick an available player and place an *opening bid*.',
      'Alternatively they can *Skip* to pass their turn.',
      'Any opening bid must be at least ${SMALL_BLIND}.',
      'The opening turn order is at the bottom of the teams page. Full teams are skipped.',
    ],
  },
  {
    heading: 'Teams page details',
    items: [
      'Player roles are only displayed to help the captains draft good teams, they are not binding (roles can be swapped).',
    ],
  },
];

const AUCTION_INFO_VARIANTS = {
  TURN_ORDER_WATERFALL: 'It moves down the list and wraps back to the top.',
  TURN_ORDER_SNAKE:     'It snakes back and forth, so the captain at each end bids twice in a row.',
  SELL_MODE_AUTO:       'Each bid refreshes a {AUTO_SECONDS}second countdown; when it ends the player is sold to the highest bidder.',
  SELL_MODE_MANUAL:     'The admin marks the player as *Sold* once bidding settles.',
};

// Extra links shown on the captain page beside the auto-added "View Teams" link.
const CAPTAIN_LINKS = [
  // { label: 'Full Rules', url: 'https://...' },
];

module.exports = {
  STATUS,
  SELL_MODE,
  TURN_ORDER,
  TURN_DIR,
  POOL_ORDER,
  PLAYER_STATUS,
  DEFAULT_SETTINGS,
  ROLE_LABELS,
  PLAYER_SHUFFLE_SEED,
  OPGG_REGION,
  OPGG_MULTISEARCH_BASE,
  THEME_FONT_URLS,
  fontUrlForTheme,
  AUCTION_INFO_SECTIONS,
  AUCTION_INFO_VARIANTS,
  CAPTAIN_LINKS,
};
