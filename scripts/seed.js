/**
 * Dev helper: seed the database with sample captains + players for local testing.
 * Usage: node scripts/seed.js   (respects DB_PATH; defaults to ./auction.db)
 */

const { state, load, persistAll } = require('../server/state');
const { PLAYER_STATUS } = require('../server/config');

load();

const captains = [
  { name: 'Monarch', code: 'mon', price: 5, role: 'Top' },
  { name: 'Tomi', code: 'tom', price: 4, role: 'Jungle' },
  { name: 'Vex', code: 'vex', price: 6, role: 'ADC' },
  { name: 'Luna', code: 'lun', price: 3, role: 'Support' },
];

const players = [
  ['Faker', 'Mid'], ['Caps', 'Mid'], ['Chovy', 'Mid'],
  ['Oner', 'Jungle'], ['Canyon', 'Jungle'],
  ['Gumayusi', 'ADC'], ['Ruler', 'ADC'], ['Viper', 'ADC'],
  ['Keria', 'Support'], ['BeryL', 'Support'],
  ['Zeus', 'Top'], ['Bin', 'Top'], ['Kingen', 'Top'],
  ['Flex', 'Fill'],
];

// Append a Riot tag so the seed data exercises the multi-op.gg links on the board;
// the bare name (without #EUW) doubles as the discord name for the team string.
state.captains = captains.map((c, i) => ({ id: i + 1, name: c.name + '#EUW', code: c.code, price: c.price, role: c.role || '', seat: i, discord: c.name }));
state.players = players.map(([name, role], i) => ({
  id: i + 1, name: name + '#EUW', role, status: PLAYER_STATUS.OPEN, captainId: null, price: 0, discord: name,
}));
state.auction = { currentPlayerId: null, highestBid: 0, byCaptainId: null };

persistAll();
console.log(`Seeded ${state.captains.length} captains and ${state.players.length} players.`);
console.log('Captain codes:', state.captains.map((c) => `${c.name}=${c.code}`).join(', '));
