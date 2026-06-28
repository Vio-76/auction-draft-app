/**
 * Builds the JSON payloads pushed to clients. The shapes intentionally match the old
 * Apps Script getState / getBoardState results so the captain page and board rendering
 * code port over with minimal change. Ported from WebApp.js (getState, getBoardState,
 * buildInfoSections).
 */

const { state, captainById, playerById, captainsBySeat } = require('./state');
const {
  STATUS, SELL_MODE, TURN_ORDER, TURN_DIR, ROLE_LABELS,
  AUCTION_INFO_SECTIONS, AUCTION_INFO_VARIANTS,
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

  return result;
}

// ----- spectator board state -----

function buildBoardState() {
  const s = state.settings;
  const caps = captainsBySeat();

  const teams = caps.map((c) => {
    const drafted = require('./state').draftedPlayers(c.id);
    const players = [];
    for (let i = 0; i < s.teamSlots; i++) {
      const p = drafted[i];
      players.push({ name: p ? p.name : '', price: p ? p.price : 0 });
    }
    return {
      captain:      c.name,
      captainPrice: c.price,
      captainRole:  c.role || '',
      players,
      maxBid:       team.captainMaxBid(c),
      full:         team.isCaptainFull(c),
      roles:        team.captainRoleFlags(c),
    };
  });

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
  };
}

// ----- admin state (full picture for the admin console) -----

function buildAdminState() {
  const s = state.settings;
  const cur = turn.currentTurnCaptain();

  const captains = captainsBySeat().map((c) => ({
    id: c.id, name: c.name, code: c.code, price: c.price, role: c.role || '', seat: c.seat,
    maxBid: team.captainMaxBid(c), full: team.isCaptainFull(c),
    draftedCount: team.draftedCount(c), spent: team.spentByCaptain(c),
  }));

  const players = state.players.map((p) => ({
    id: p.id, name: p.name, role: p.role, status: p.status,
    captainId: p.captainId, captainName: p.captainId ? (captainById(p.captainId)?.name || '') : '',
    price: p.price,
  }));

  return {
    settings: { ...s, turnDirection: s.turnDirection === TURN_DIR.UP ? 'UP' : 'DOWN' },
    phase: s.status,
    currentTurnCaptain: cur ? cur.name : '',
    soldArmed: s.status === STATUS.BIDDING && sell.soldButtonUsable(),
    auction: {
      player: state.auction.currentPlayerId ? (playerById(state.auction.currentPlayerId)?.name || '') : '',
      highestBid: state.auction.highestBid,
      byCaptain: state.auction.byCaptainId ? (captainById(state.auction.byCaptainId)?.name || '') : '',
    },
    captains,
    players,
  };
}

module.exports = { buildInfoSections, buildCaptainState, buildBoardState, buildAdminState };
