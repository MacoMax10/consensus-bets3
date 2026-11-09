import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, traderWeight } from '../src/analysis.js';
import { describeBet, matchOdds, pmOdds, sameTeam } from '../src/odds.js';
import { planStakes, riskLabel } from '../public/planner.js';
import { redact } from '../src/http.js';
import { normalizeClosed, normalizePosition, normalizeTrader } from '../src/polymarket.js';
import { selectTopTraders, sportsStats } from '../src/pool.js';
import { gameStatus, leagueOf, localDate, parseTime, sportFamily } from '../src/sports.js';

const cfg = { minPrice: 0.05, maxPrice: 0.9, minPositionUsd: 50, marketMakerHedgeShare: 0.2, marketMakerMinHedges: 3, minHoldersToStore: 2 };

const pos = (wallet, conditionId, outcome, outcomeIndex, { size = 1000, avgPrice = 0.4, curPrice = 0.5 } = {}) => ({
  wallet, conditionId, outcome, outcomeIndex, size, avgPrice, curPrice,
  initialValue: size * avgPrice, currentValue: size * curPrice, cashPnl: size * (curPrice - avgPrice),
  title: `Market ${conditionId}`, slug: conditionId, eventSlug: conditionId,
});
const trader = (wallet, edge = 0.1) => ({ wallet, rank: 1, name: wallet, pnl: 1000, volume: 10000, edge, winRate: 0.6 });
// A market that is a game today and hasn't started.
const game = (id, extra = {}) => [id, { conditionId: id, question: `Game ${id}`, outcomes: ['Yes', 'No'], prices: [], gameStatus: 'upcoming',
  gameStartMs: Date.parse('2026-10-29T23:00:00Z'), league: 'nba', sport: 'Basketball', closed: false, acceptingOrders: true, ...extra }];

test('normalizes v2 (snake_case) and v1 (camelCase) rows to the same shape', () => {
  const v2 = normalizePosition({ proxy_wallet: '0xABC', condition_id: 'c1', current_size: 10, avg_price: 0.4, current_price: 0.5, entry_cost_usdc: 4, outcome: 'Yes', outcome_index: 0, event_slug: 'e' });
  const v1 = normalizePosition({ proxyWallet: '0xabc', conditionId: 'c1', size: 10, avgPrice: 0.4, curPrice: 0.5, initialValue: 4, outcome: 'Yes', outcomeIndex: 0, eventSlug: 'e' });
  for (const k of ['wallet', 'conditionId', 'size', 'avgPrice', 'curPrice', 'initialValue', 'outcomeIndex', 'eventSlug']) assert.equal(v2[k], v1[k], k);
  assert.equal(normalizeTrader({ user_id: '0xA', volume: 5 }).wallet, '0xa');
  assert.equal(normalizeClosed({ avg_price: 0.6, realized_pnl: 12, event_slug: 'nba-a-b-2026-10-01' }).realizedPnl, 12);
});

test('sports detection, time zones and game status', () => {
  assert.equal(leagueOf('nba-lal-bos-2026-10-29'), 'nba');
  assert.equal(leagueOf('epl-ars-che-2026-10-29-ars'), 'epl');
  assert.equal(leagueOf('will-trump-win-2028'), null);
  assert.equal(leagueOf('fifwc-ecu-ger-2026-06-25-ger'), 'fifwc'); // real slug from the live API
  assert.equal(sportFamily('fifwc'), 'Soccer');
  assert.equal(leagueOf('xyz-aaa-bbb-2026-10-29'), 'xyz'); // unknown league, still a game
  assert.equal(sportFamily('xyz'), 'Other sports');
  assert.equal(sportFamily('epl'), 'Soccer');
  assert.equal(parseTime('2026-10-29 23:00:00+00'), Date.parse('2026-10-29T23:00:00Z'));
  // 2:30 AM UTC on the 30th is still the 29th in New York.
  assert.equal(localDate(Date.parse('2026-10-30T02:30:00Z'), 'America/New_York'), '2026-10-29');
  const now = Date.parse('2026-10-29T18:00:00Z'); // 2 PM New York
  assert.equal(gameStatus(Date.parse('2026-10-29T23:30:00Z'), now), 'upcoming');
  assert.equal(gameStatus(Date.parse('2026-10-29T16:00:00Z'), now), 'started');
  assert.equal(gameStatus(Date.parse('2026-10-30T23:00:00Z'), now), 'not_today');
});

test('edge = win rate minus average price paid; favourites-only bettors rank low', () => {
  const closed = (n, price, winShare, slug = 'nba-lal-bos-2026-10-01') =>
    Array.from({ length: n }, (_, i) => ({ eventSlug: slug, avgPrice: price, realizedPnl: i < n * winShare ? 5 : -5 }));
  const skilled = sportsStats(closed(40, 0.5, 0.7));          // wins 70% at 50¢ -> +20 pts
  const chalk = sportsStats(closed(40, 0.95, 0.9));           // wins 90% at 95¢ -> -5 pts
  const mixed = sportsStats([...closed(30, 0.5, 0.6), ...closed(30, 0.5, 1, 'us-election-2028')]); // non-sports ignored
  assert.ok(Math.abs(skilled.edge - 0.2) < 1e-9);
  assert.ok(chalk.winRate > skilled.winRate && chalk.edge < 0);
  assert.equal(mixed.sportsBets, 30);
  const top = selectTopTraders([
    { wallet: 'chalk', ...chalk }, { wallet: 'skilled', ...skilled }, { wallet: 'lucky', ...sportsStats(closed(10, 0.5, 1)) },
  ], { minSportsBets: 30, topTraders: 200 });
  assert.deepEqual(top.map((t) => t.wallet), ['skilled', 'chalk']); // "lucky" has too few bets
  assert.equal(top[0].poolRank, 1);
});

test('trader weight grows with edge, bounded 0.5..1', () => {
  assert.equal(traderWeight({ edge: -0.1 }), 0.5);
  assert.equal(traderWeight({ edge: 0.3 }), 1);
  assert.ok(traderWeight({ edge: 0.1 }) > traderWeight({ edge: 0.05 }));
});

test('only games today are kept; started games are flagged', () => {
  const traders = ['a', 'b'].map((w) => trader(w));
  const positions = new Map(['a', 'b'].map((w) => [w, [pos(w, 'g1', 'Yes', 0), pos(w, 'g2', 'Yes', 0), pos(w, 'future', 'Yes', 0), pos(w, 'politics', 'Yes', 0)]]));
  const markets = new Map([game('g1'), game('g2', { gameStatus: 'started' }), game('future', { gameStatus: 'not_today' })]);
  const { bets } = analyze({ traders, positions, markets, cfg });
  assert.deepEqual(bets.map((b) => [b.conditionId, b.flags]), [['g1', []], ['g2', ['started']]]);
  assert.equal(bets[0].sport, 'Basketball');
});

test('groups by market + outcome, counts agreement and size-weighted entry', () => {
  const traders = ['a', 'b', 'c', 'd'].map((w) => trader(w));
  const positions = new Map([
    ['a', [pos('a', 'm1', 'Yes', 0, { size: 1000, avgPrice: 0.4 })]],
    ['b', [pos('b', 'm1', 'Yes', 0, { size: 3000, avgPrice: 0.6 })]],
    ['c', [pos('c', 'm1', 'No', 1)]],
    ['d', []],
  ]);
  const { bets, eligibleCount } = analyze({ traders, positions, markets: new Map([game('m1')]), cfg });
  assert.equal(eligibleCount, 4);
  const yes = bets.find((b) => b.key === 'm1:0');
  assert.equal(yes.holders, 2);
  assert.equal(yes.opposingHolders, 1);
  assert.ok(Math.abs(yes.avgEntry - 0.55) < 1e-9);
});

test('flags price extremes', () => {
  const traders = ['a', 'b'].map((w) => trader(w));
  const positions = new Map(['a', 'b'].map((w) => [w, [pos(w, 'hi', 'Yes', 0, { curPrice: 0.95 }), pos(w, 'lo', 'Yes', 0, { curPrice: 0.03, size: 5000 }), pos(w, 'ok', 'Yes', 0)]]));
  const { bets } = analyze({ traders, positions, markets: new Map([game('hi'), game('lo'), game('ok')]), cfg });
  const flags = Object.fromEntries(bets.map((b) => [b.conditionId, b.flags]));
  assert.deepEqual(flags, { hi: ['price_above_max'], lo: ['price_below_min'], ok: [] });
});

test('both-sides holders dropped from that market; heavy hedgers excluded as market makers', () => {
  const traders = ['a', 'b', 'mm'].map((w) => trader(w));
  const hedge = (w, id) => [pos(w, id, 'Yes', 0), pos(w, id, 'No', 1)];
  const positions = new Map([
    ['a', [pos('a', 'm1', 'Yes', 0), ...hedge('a', 'm2')]],
    ['b', [pos('b', 'm1', 'Yes', 0), pos('b', 'm2', 'Yes', 0)]],
    ['mm', [...hedge('mm', 'x1'), ...hedge('mm', 'x2'), ...hedge('mm', 'x3'), pos('mm', 'm1', 'Yes', 0)]],
  ]);
  const { bets, traders: stats, eligibleCount } = analyze({ traders, positions, markets: new Map([game('m1'), game('m2')]), cfg });
  assert.equal(stats.find((t) => t.wallet === 'mm').excludedReason, 'market_maker');
  assert.equal(eligibleCount, 2);
  assert.equal(bets.find((b) => b.key === 'm1:0').holders, 2);
  assert.equal(bets.find((b) => b.key === 'm2:0'), undefined);
});

test('team names: Polymarket short names match sportsbook full names', () => {
  assert.ok(sameTeam('Celtics', 'Boston Celtics'));
  assert.ok(sameTeam('LA Clippers', 'Los Angeles Clippers'));
  assert.ok(!sameTeam('LA Clippers', 'Los Angeles Lakers'));
  assert.ok(sameTeam('Man City', 'Manchester City'));
  assert.ok(sameTeam('Arsenal FC', 'Arsenal'));
  assert.ok(sameTeam('Atlético Madrid', 'Atletico Madrid'));
  assert.ok(!sameTeam('Manchester United', 'Manchester City'));
});

test('which side a Polymarket bet is backing', () => {
  assert.deepEqual(describeBet({ title: 'Lakers vs. Celtics', outcome: 'Celtics' }), { pick: 'Celtics', teams: ['Lakers', 'Celtics'] });
  assert.equal(describeBet({ title: 'Will Arsenal FC win on 2026-11-04?', outcome: 'Yes' }).pick, 'Arsenal FC');
  assert.equal(describeBet({ title: 'Will Arsenal FC win on 2026-11-04?', outcome: 'No' }), null); // no straight sportsbook bet
  assert.equal(describeBet({ title: 'Arsenal vs. Chelsea: end in a draw?', outcome: 'Yes', slug: 'epl-ars-che-2026-11-04-draw' }).pick, 'Draw');
  assert.equal(describeBet({ title: 'Spread: Celtics (-5.5)', outcome: 'Celtics' }), null);
  assert.equal(describeBet({ title: 'Lakers vs. Celtics: O/U 221.5', outcome: 'Over' }), null);
  assert.equal(describeBet({ title: 'Lakers vs. Celtics', outcome: 'Celtics', marketType: 'spreads' }), null);
});

test('best sportsbook price for a bet', () => {
  const start = '2026-11-04T23:30:00Z';
  const ev = (id, home, away, books, t = start) => ({ id, commence_time: t, home_team: home, away_team: away, bookmakers: books });
  const book = (title, prices) => ({ title, last_update: start, markets: [{ key: 'h2h', outcomes: Object.entries(prices).map(([name, price]) => ({ name, price })) }] });
  const events = new Map([
    ['basketball_nba', [
      ev('e1', 'Boston Celtics', 'Los Angeles Lakers', [book('DraftKings', { 'Boston Celtics': 1.69, 'Los Angeles Lakers': 2.25 }), book('FanDuel', { 'Boston Celtics': 1.74, 'Los Angeles Lakers': 2.18 })]),
      ev('e2', 'Boston Celtics', 'Miami Heat', [book('FanDuel', { 'Boston Celtics': 1.3 })], '2026-11-06T23:30:00Z'), // another day
    ]],
    ['soccer_epl', [ev('e3', 'Arsenal', 'Chelsea', [book('BetMGM', { Arsenal: 2.05, Chelsea: 3.6, Draw: 3.4 })])]],
  ]);
  const celtics = matchOdds({ league: 'nba', title: 'Lakers vs. Celtics', outcome: 'Celtics', gameStart: start }, events);
  assert.deepEqual([celtics.price, celtics.book, celtics.eventId], [1.74, 'FanDuel', 'e1']);
  assert.equal(matchOdds({ league: 'epl', title: 'Arsenal vs. Chelsea: draw?', outcome: 'Yes', slug: 'epl-ars-che-2026-11-04-draw', gameStart: start }, events).price, 3.4);
  assert.equal(matchOdds({ league: 'epl', title: 'Will Arsenal FC win on 2026-11-04?', outcome: 'Yes', gameStart: start }, events).price, 2.05);
  assert.equal(matchOdds({ league: 'nhl', title: 'Bruins vs. Rangers', outcome: 'Bruins', gameStart: start }, events), null); // no odds loaded
  assert.equal(pmOdds(0.58), 1.72);
});

test('bet planner: more money on locks, total always equals the budget', () => {
  const picks = [
    { key: 'lock', p: 0.78, odds: 1.25, score: 40 },
    { key: 'coin', p: 0.6, odds: 1.7, score: 30 },
    { key: 'risky', p: 0.42, odds: 2.4, score: 25 },
  ];
  const locks = planStakes(picks, 100, 'locks');
  assert.deepEqual(locks.rows.map((r) => r.stake), [69, 24, 7]);
  assert.equal(locks.total, 100);
  assert.equal(locks.rows[0].payout, 86.25); // 69 x 1.25
  assert.deepEqual(planStakes(picks, 100, 'equal').rows.map((r) => r.stake), [34, 33, 33]);
  // Balanced sits between the two.
  const bal = planStakes(picks, 100, 'balanced').rows.map((r) => r.stake);
  assert.ok(bal[0] < 69 && bal[0] > 34 && bal[2] > 7);
  // Small budgets split to the cent and still add up exactly.
  const small = planStakes(picks, 10, 'locks');
  assert.equal(Math.round(small.rows.reduce((s, r) => s + r.stake, 0) * 100), 1000);
  // Odd budgets: whole dollars that still sum exactly.
  assert.equal(planStakes(picks, 257, 'balanced').rows.reduce((s, r) => s + r.stake, 0), 257);
  // Nothing to plan.
  assert.equal(planStakes(picks, 0).total, 0);
  assert.equal(planStakes([], 100).total, 0);
  assert.deepEqual([0.8, 0.6, 0.5, 0.3].map(riskLabel), ['Lock', 'Likely', 'Toss-up', 'Risky']);
});

test('API keys never appear in error messages', () => {
  assert.equal(redact('https://api.the-odds-api.com/v4/sports?apiKey=abc123&regions=us'), 'https://api.the-odds-api.com/v4/sports?apiKey=***&regions=us');
});
