/**
 * Builds the JSON payloads pushed to clients. The shapes intentionally match the old
 * Apps Script getState / getBoardState results so the captain page and board rendering
 * code port over with minimal change. Ported from WebApp.js (getState, getBoardState,
 * buildInfoSections).
 */

const { state, captainById, captainByName, playerById, captainsBySeat, draftedPlayers } = require('./state');
const {
  STATUS, SELL_MODE, TURN_ORDER, TURN_DIR, ROLE_LABELS,
  AUCTION_INFO_SECTIONS, AUCTION_INFO_VARIANTS,
  OPGG_REGION, OPGG_MULTISEARCH_BASE,
} = require('./config');
const team = require('./logic/team');
const turn = require('./logic/turn');
const sell = require('./logic/sell');
const fillup = require('./logic/fillup');

// ----- info / rules panel -----

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildInfoSections() {
  const s = state.settings;
  const sellAuto = s.sellMode === SELL_MODE.AUTO;
  const snake = s.turnOrder === TURN_ORDER.SNAKE;

  const tiers = s.tiers || [];
  const valueTokens = {
    OPENING_SECONDS: s.openingTimeout,
    AUTO_SECONDS:    s.autoWindow,
    SMALL_BLIND:     s.smallBlind,
    TEAM_BUDGET:     s.teamBudget,
    NUM_CAPTAINS:    state.captains.length,
    // e.g. "S-Tier $30, A-Tier $15" — tier names are admin input, so escape them here (values are
    // inserted after the item text was escaped).
    TIER_MINS:       tiers.map((t) => `${escapeHtml(t.name)} $${t.minBid}`).join(', '),
  };
  const snippetTokens = {
    TURN_ORDER: snake ? AUCTION_INFO_VARIANTS.TURN_ORDER_SNAKE : AUCTION_INFO_VARIANTS.TURN_ORDER_WATERFALL,
    SELL_MODE:  sellAuto ? AUCTION_INFO_VARIANTS.SELL_MODE_AUTO : AUCTION_INFO_VARIANTS.SELL_MODE_MANUAL,
    OPENING_MIN: tiers.length ? AUCTION_INFO_VARIANTS.OPENING_MIN_TIERED : AUCTION_INFO_VARIANTS.OPENING_MIN_FLAT,
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

  const onBlock = state.auction.currentPlayerId ? playerById(state.auction.currentPlayerId) : null;
  const player = onBlock ? onBlock.name : '';
  const byCap = state.auction.byCaptainId ? (captainById(state.auction.byCaptainId)?.name || '') : '';

  const result = {
    captain:            captain.name,
    phase,
    sellMode:           s.sellMode,
    currentTurnCaptain,
    isYourTurnToOpen:   !!isYourTurnToOpen,
    player,
    playerImage:        team.playerImageUrl(onBlock),   // card shown while the player is on the block (#8)
    priceCeiling:       team.priceCeiling(onBlock),     // tier price ceiling (null = none): bids above it are flagged red
    highestBid:         state.auction.highestBid,
    byCaptain:          byCap,
    yourMaxBid:         team.captainMaxBid(captain),
    smallBlind:         team.defaultMinBid(),   // min opening bid for untiered players (field name kept for captain.js)
    youAreFull:         team.isCaptainFull(captain),
    youAreBroke:        team.isCaptainBroke(captain),
    yourOpenSlots:      Math.max(0, s.teamSlots - team.draftedCount(captain)),
  };

  if (isYourTurnToOpen) {
    result.openPlayers = team.openPlayersForOpening();   // [{name, tier, minBid}]
    result.secondsRemaining = turn.openingSecondsRemaining();
  }

  if (phase === STATUS.BIDDING && s.sellMode === SELL_MODE.AUTO) {
    result.sellWindowSeconds = s.autoWindow;
    result.sellSecondsRemaining = sell.autoSellSecondsRemaining();
  }

  // Fill-up round (#7): whose pick it is, this captain's place in the stack, and (on their pick)
  // the pickable players grouped by tier with the quotas left.
  if (phase === STATUS.FILLUP) {
    const order = fillup.currentOrder();
    const picker = order[0] || null;
    result.teamSlots = s.teamSlots;
    result.fillPicker = picker ? picker.name : '';
    result.isYourFillPick = !!picker && picker.id === captain.id;
    const pos = order.findIndex((c) => c.id === captain.id);
    result.fillPosition = pos >= 0 ? pos + 1 : 0;       // 0 = not in the stack (full / done)
    if (result.isYourFillPick) result.fillPickGroups = fillup.pickGroups();
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
  const finished = s.status === STATUS.FINISHED;
  const identity = finished || !!s.teamIdentityAlways;   // team name + logo visible on the board?

  const teams = caps.map((c) => {
    const drafted = draftedPlayers(c.id);
    const players = [];
    for (let i = 0; i < s.teamSlots; i++) {
      const p = drafted[i];
      // coCaptain: drawn under the captain with the co-captain crown (draftedPlayers puts it first).
      players.push({ name: p ? p.name : '', price: p ? p.price : 0, coCaptain: !!(p && p.coCaptain),
        // player card (#8) + the card caption's role/tier
        image: team.playerImageUrl(p), role: p ? (p.role || '') : '', tierId: p && team.tierById(p.tierId) ? p.tierId : null });
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
      broke:        team.isCaptainBroke(c),
      pricedOut,
      leading,
      roles:        team.captainRoleFlags(c),
      // Team identity. The group stays FINISHED-only (it's decided from the finished teams). Name +
      // logo show once FINISHED, or for the whole auction when teamIdentityAlways is on; the name
      // can be hidden entirely (logo only) via showTeamNameOnBoard. Anything not shown is kept off
      // the wire, so it can't be read from the payload either.
      teamGroup:    finished ? (c.teamGroup || '') : '',
      teamName:     (identity && s.showTeamNameOnBoard) ? (c.teamName || '') : '',
      teamLogo:     (identity && c.logo) ? '/uploads/' + c.logo : '',
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
      liveBid = { player: p.name, highestBid: state.auction.highestBid, byCaptain: by ? by.name : '',
        // player card (#8) + what the expanded card's caption needs
        image: team.playerImageUrl(p), role: p.role || '', tierId: team.tierById(p.tierId) ? p.tierId : null,
        over: team.isAboveCeiling(p, state.auction.highestBid) };   // above the tier price ceiling → red band
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
    broke:        team.brokeByName(),
  };

  return {
    teams,
    highestBid:  state.auction.highestBid,
    openPlayers: team.openPlayersWithRoles(),
    // Tier list (admin order) + the default minimum, for the pool's Role/Tier switch. Tier names,
    // minimums and assignments are public on the board (they're auction rules, not bids).
    tiers:         (s.tiers || []).map((t) => ({ id: t.id, name: t.name, minBid: t.minBid, rangeMin: t.rangeMin ?? null, rangeMax: t.rangeMax ?? null })),
    defaultMinBid: team.defaultMinBid(),
    turn:        turnInfo,
    liveBid,
    // Whether the per-team available-budget bar shows on the board team cards (admin toggle).
    showBudgetOnBoard: s.showBudgetOnBoard,
    // Timed opening-bid announcement (image + "X placed a $N opening bid on Y"). It names the bid
    // amount + bidder, so on the public board it's gated by showBidOnBoard exactly like liveBid
    // (captains always get it in buildCaptainState — they're participants).
    openingMessage: s.showBidOnBoard ? sell.recentOpeningMessage() : null,
    fill: buildFillState(),
    // Timed "sold" banner (same as the captain page). Ungated: the sale result (player/winner/price)
    // is already public on the board — sold players show with their price in the team rosters.
    soldMessage: boardSoldMessage(identity && s.showTeamNameOnBoard),
  };
}

/** The board's sold banner, plus the winner's team name (shown in brackets after the captain) while
 *  team names are visible on the board — same gating as the team cards. */
function boardSoldMessage(showTeamName) {
  const m = sell.recentSoldMessage();
  if (!m) return null;
  const c = showTeamName ? captainByName(m.winner) : null;
  return { ...m, teamName: (c && c.teamName) || '' };
}

// ----- fill-up round (#7) -----

/** The fill-up stack for the board (+ admin): during the auction the projected order of the broke
 *  captains (it grows as they go broke); during FILLUP the frozen order, who's done, and which
 *  pool players are still pickable (base tier = any number; tiers above base = quota left). */
function buildFillState() {
  const s = state.settings;
  const active = s.status === STATUS.FILLUP;
  // brokeSeq lets the board bracket captains who went broke at the same moment.
  const order = fillup.currentOrder().map((c) => ({ id: c.id, name: c.name, slots: fillup.openSlots(c), brokeSeq: c.brokeSeq || 0 }));
  const out = { active, order };
  if (active) {
    out.done = (s.fillDone || []).map((id) => captainById(id)).filter(Boolean).map((c) => c.name);
    const low = team.lowestTier();
    out.baseTierId = low ? low.id : null;               // untiered players are base too
    out.quota = {};
    for (const t of fillup.tiersAboveBase()) out.quota[t.id] = fillup.quotaLeft(t.id);
  }
  return out;
}

// ----- discord team string (admin-only; consumed by an external role-assign bot) -----

/** "Team 1: <captainDiscord>, <player discords…> | Team 2: …" in board (seat) order.
 *  Captain first, then their drafted players; blank discord names are skipped. Ported
 *  from the spreadsheet TEXTJOIN formulas. */
function buildTeamString() {
  return captainsBySeat().map((c, i) => {
    const discords = [c.discord, ...draftedPlayers(c.id).map((p) => p.discord)]
      .map((d) => (d || '').trim())
      .filter(Boolean);
    return `Team ${i + 1}: ${discords.join(', ')}`;
  }).join(' | ');
}

// ----- admin state (full picture for the admin console) -----

function buildAdminState() {
  const s = state.settings;
  const cur = turn.currentTurnCaptain();

  const captains = captainsBySeat().map((c) => ({
    id: c.id, name: c.name, code: c.code, price: c.price, role: c.role || '', seat: c.seat,
    discord: c.discord || '',
    teamGroup: c.teamGroup || '', teamName: c.teamName || '', logo: c.logo || '',
    maxBid: team.captainMaxBid(c), full: team.isCaptainFull(c), broke: team.isCaptainBroke(c), brokeSeq: c.brokeSeq || 0,
    draftedCount: team.draftedCount(c), spent: team.spentByCaptain(c),
  }));

  const players = state.players.map((p) => ({
    id: p.id, name: p.name, role: p.role, status: p.status,
    captainId: p.captainId, captainName: p.captainId ? (captainById(p.captainId)?.name || '') : '',
    price: p.price, discord: p.discord || '', image: p.image || '', coCaptain: !!p.coCaptain,
    tierId: team.tierById(p.tierId) ? p.tierId : null,   // null if untiered (or its tier was removed)
  }));

  const openingSecondsRemaining = s.status === STATUS.OPENING ? turn.openingSecondsRemaining() : null;
  const autoSellSecondsRemaining = (s.status === STATUS.BIDDING && s.sellMode === SELL_MODE.AUTO)
    ? sell.autoSellSecondsRemaining() : null;
  const pausedRemaining = s.status === STATUS.CLOSED ? (state.clocks.pausedRemaining || null) : null;

  return {
    settings: { ...s, turnDirection: s.turnDirection === TURN_DIR.UP ? 'UP' : 'DOWN' },
    phase: s.status,
    currentTurnCaptain: s.status === STATUS.FILLUP ? ((fillup.currentPicker() || {}).name || '') : (cur ? cur.name : ''),
    fill: buildFillState(),
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
