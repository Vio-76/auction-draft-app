/**
 * Builds the JSON payloads pushed to clients. The shapes intentionally match the old
 * Apps Script getState / getBoardState results so the captain page and board rendering
 * code port over with minimal change. Ported from WebApp.js (getState, getBoardState,
 * buildInfoSections).
 */

const { state, captainById, playerById, captainsBySeat, draftedPlayers } = require('./state');
const {
  STATUS, SELL_MODE, TURN_ORDER, TURN_DIR, ROLE_LABELS,
  AUCTION_INFO_SECTIONS, AUCTION_INFO_VARIANTS,
  OPGG_REGION, OPGG_MULTISEARCH_BASE,
} = require('./config');
const team = require('./logic/team');
const turn = require('./logic/turn');
const sell = require('./logic/sell');

// ----- info / rules panel -----

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildInfoSections() {
  const s = state.settings;
  const sellAuto = s.sellMode === SELL_MODE.AUTO;
  const snake = s.turnOrder === TURN_ORDER.SNAKE;

  const valueTokens = {
    OPENING_SECONDS: s.openingTimeout,
    AUTO_SECONDS:    s.autoWindow,
    SMALL_BLIND:     s.smallBlind,
    TEAM_BUDGET:     s.teamBudget,
    NUM_CAPTAINS:    state.captains.length,
  };
  const snippetTokens = {
    TURN_ORDER: snake ? AUCTION_INFO_VARIANTS.TURN_ORDER_SNAKE : AUCTION_INFO_VARIANTS.TURN_ORDER_WATERFALL,
    SELL_MODE:  sellAuto ? AUCTION_INFO_VARIANTS.SELL_MODE_AUTO : AUCTION_INFO_VARIANTS.SELL_MODE_MANUAL,
  };

  const fillFrom = (map, wrap) => (str) =>
    str.replace(/\{(\w+)\}/g, (m, key) => {
      if (!Object.prototype.hasOwnProperty.call(map, key)) return m;
      return wrap ? `<span class="info-val">${map[key]}</span>` : map[key];
    });
  const fillSnippets = fillFrom(snippetTokens, false);
  const fillValues = fillFrom(valueTokens, true);

  return AUCTION_INFO_SECTIONS.map((sec) => ({
    heading: sec.heading,
    items: sec.items.map((item) => {
      const html = fillValues(fillSnippets(escapeHtml(item)));
      return html.replace(/\*([^*]+)\*/g, '<span class="info-key">$1</span>');
    }),
  }));
}

// ----- captain state (per captain) -----

function buildCaptainState(captain) {
  const s = state.settings;
  const phase = s.status;
  const cur = turn.currentTurnCaptain();
  const currentTurnCaptain = cur ? cur.name : '';
  const isYourTurnToOpen = phase === STATUS.OPENING && cur && cur.id === captain.id;

  const player = state.auction.currentPlayerId ? (playerById(state.auction.currentPlayerId)?.name || '') : '';
  const byCap = state.auction.byCaptainId ? (captainById(state.auction.byCaptainId)?.name || '') : '';

  const result = {
    captain:            captain.name,
    phase,
    sellMode:           s.sellMode,
    currentTurnCaptain,
    isYourTurnToOpen:   !!isYourTurnToOpen,
    player,
    highestBid:         state.auction.highestBid,
    byCaptain:          byCap,
    yourMaxBid:         team.captainMaxBid(captain),
    smallBlind:         s.smallBlind,
    youAreFull:         team.isCaptainFull(captain),
  };

  if (isYourTurnToOpen) {
    result.openPlayers = team.openPlayerNames();
    result.secondsRemaining = turn.openingSecondsRemaining();
  }

  if (phase === STATUS.BIDDING && s.sellMode === SELL_MODE.AUTO) {
    result.sellWindowSeconds = s.autoWindow;
    result.sellSecondsRemaining = sell.autoSellSecondsRemaining();
  }

  const soldMessage = sell.recentSoldMessage();
  if (soldMessage) result.soldMessage = soldMessage;

  const openingMessage = sell.recentOpeningMessage();
  if (openingMessage) result.openingMessage = openingMessage;

  return result;
}

// ----- spectator board state -----

/** op.gg multi-search URL for a list of summoner names (captain + drafted players).
 *  Each name is URL-encoded (so '#' in a Riot ID becomes %23) and joined with %2C.
 *  Returns null if there are no usable names. */
function multiSearchUrl(names) {
  const valid = names.filter((n) => n && n.trim());
  if (!valid.length) return null;
  const q = valid.map((n) => encodeURIComponent(n.trim())).join('%2C');
  return `${OPGG_MULTISEARCH_BASE}/${OPGG_REGION}?summoners=${q}`;
}

function buildBoardState() {
  const s = state.settings;
  const caps = captainsBySeat();

  const hb = state.auction.highestBid;
  const byId = state.auction.byCaptainId;

  const teams = caps.map((c) => {
    const drafted = require('./state').draftedPlayers(c.id);
    const players = [];
    for (let i = 0; i < s.teamSlots; i++) {
      const p = drafted[i];
      players.push({ name: p ? p.name : '', price: p ? p.price : 0 });
    }
    const maxBid = team.captainMaxBid(c);
    const spent = team.spentByCaptain(c);
    const full = team.isCaptainFull(c);
    // Priced out: the live bid already meets/exceeds this captain's max so they can't outbid.
    // Gated by showBidOnBoard (it's derived from the live bid) and excludes the current leader.
    const pricedOut = s.showBidOnBoard && !full && hb > 0 && maxBid <= hb && c.id !== byId;
    // Leading: this captain holds the current high bid (shown highlighted). Also bid-derived,
    // so only when bids are public.
    const leading = s.showBidOnBoard && hb > 0 && c.id === byId;
    return {
      captain:      c.name,
      captainPrice: c.price,
      players,
      maxBid,
      // Total budget + unspent remainder — drives the per-team "available budget" meter on the
      // board card (a concrete anchor so the max-bid figure feels less arbitrary).
      teamBudget:   s.teamBudget,
      leftOver:     s.teamBudget - spent,
      full,
      pricedOut,
      leading,
      roles:        team.captainRoleFlags(c),
      // Once the auction is over, expose a multi-op.gg link for the whole roster
      // (captain first, then drafted players). Works for partial teams too.
      oppgUrl:      s.status === STATUS.FINISHED
        ? multiSearchUrl([c.name, ...drafted.map((p) => p.name)])
        : null,
    };
  });

  // Live bid panel — only sent when enabled (so it stays private from spectators when off)
  // and only while a player is actually on the block.
  let liveBid = null;
  if (s.showBidOnBoard && state.auction.currentPlayerId) {
    const p = playerById(state.auction.currentPlayerId);
    const by = state.auction.byCaptainId ? captainById(state.auction.byCaptainId) : null;
    if (p) {
      liveBid = { player: p.name, highestBid: state.auction.highestBid, byCaptain: by ? by.name : '' };
      // AUTO mode: also send the auto-sell countdown so the board can race a clock. When the
      // auction isn't actively bidding (e.g. admin paused) freeze it at the snapshot remaining.
      if (s.sellMode === SELL_MODE.AUTO) {
        liveBid.window = s.autoWindow;
        if (s.status === STATUS.BIDDING) {
          liveBid.secondsRemaining = sell.autoSellSecondsRemaining();
        } else {
          liveBid.paused = true;
          liveBid.secondsRemaining = (state.clocks.pausedRemaining && state.clocks.pausedRemaining.kind === 'autosell')
            ? state.clocks.pausedRemaining.seconds
            : s.autoWindow;
        }
      }
    }
  }

  const fullByName = team.fullByName();
  const turnInfo = {
    order:        caps.map((c) => c.name),
    currentIndex: s.marker,
    mode:         s.turnOrder,
    direction:    s.turnDirection === TURN_DIR.UP ? 'UP' : 'DOWN',
    phase:        s.status,
    full:         fullByName,
  };

  return {
    teams,
    highestBid:  state.auction.highestBid,
    openPlayers: team.openPlayersWithRoles(),
    turn:        turnInfo,
    liveBid,
    // Whether the per-team available-budget bar shows on the board team cards (admin toggle).
    showBudgetOnBoard: s.showBudgetOnBoard,
    // Timed opening-bid announcement (image + "X placed a $N opening bid on Y"). It names the bid
    // amount + bidder, so on the public board it's gated by showBidOnBoard exactly like liveBid
    // (captains always get it in buildCaptainState — they're participants).
    openingMessage: s.showBidOnBoard ? sell.recentOpeningMessage() : null,
    // Timed "sold" banner (same as the captain page). Ungated: the sale result (player/winner/price)
    // is already public on the board — sold players show with their price in the team rosters.
    soldMessage: sell.recentSoldMessage(),
  };
}

// ----- discord team string (admin-only; consumed by an external role-assign bot) -----

/** "Team 1: <captainDiscord>; <player discords…> | Team 2: …" in board (seat) order.
 *  Captain first, then their drafted players; blank discord names are skipped. Ported
 *  from the spreadsheet TEXTJOIN formulas. */
function buildTeamString() {
  return captainsBySeat().map((c, i) => {
    const discords = [c.discord, ...draftedPlayers(c.id).map((p) => p.discord)]
      .map((d) => (d || '').trim())
      .filter(Boolean);
    return `Team ${i + 1}: ${discords.join('; ')}`;
  }).join(' | ');
}

// ----- admin state (full picture for the admin console) -----

function buildAdminState() {
  const s = state.settings;
  const cur = turn.currentTurnCaptain();

  const captains = captainsBySeat().map((c) => ({
    id: c.id, name: c.name, code: c.code, price: c.price, role: c.role || '', seat: c.seat,
    discord: c.discord || '',
    maxBid: team.captainMaxBid(c), full: team.isCaptainFull(c),
    draftedCount: team.draftedCount(c), spent: team.spentByCaptain(c),
  }));

  const players = state.players.map((p) => ({
    id: p.id, name: p.name, role: p.role, status: p.status,
    captainId: p.captainId, captainName: p.captainId ? (captainById(p.captainId)?.name || '') : '',
    price: p.price, discord: p.discord || '', image: p.image || '',
  }));

  const openingSecondsRemaining = s.status === STATUS.OPENING ? turn.openingSecondsRemaining() : null;
  const autoSellSecondsRemaining = (s.status === STATUS.BIDDING && s.sellMode === SELL_MODE.AUTO)
    ? sell.autoSellSecondsRemaining() : null;
  const pausedRemaining = s.status === STATUS.CLOSED ? (state.clocks.pausedRemaining || null) : null;

  return {
    settings: { ...s, turnDirection: s.turnDirection === TURN_DIR.UP ? 'UP' : 'DOWN' },
    phase: s.status,
    currentTurnCaptain: cur ? cur.name : '',
    soldArmed: s.status === STATUS.BIDDING && sell.soldButtonUsable(),
    openingSecondsRemaining,
    autoSellSecondsRemaining,
    pausedRemaining,
    auction: {
      player: state.auction.currentPlayerId ? (playerById(state.auction.currentPlayerId)?.name || '') : '',
      highestBid: state.auction.highestBid,
      byCaptain: state.auction.byCaptainId ? (captainById(state.auction.byCaptainId)?.name || '') : '',
    },
    captains,
    players,
    teamString: buildTeamString(),
  };
}

module.exports = { buildInfoSections, buildCaptainState, buildBoardState, buildAdminState };
