// Builds the daily pool of the best sports bettors.
//
//   1. Top POOL_SIZE traders on Polymarket's Sports leaderboard (by profit).
//   2. For each, their last ~200 closed (resolved) positions, sports only.
//   3. Score: edge = win rate - average price paid.
//      Buying at 60¢ "should" win 60% of the time, so a trader who wins 70%
//      of their 60¢ bets has a +10-point edge. This stops people who only buy
//      95¢ favourites (95% win rate, no skill) from topping the list.
//   4. Keep the TOP_TRADERS with the highest edge and at least MIN_SPORTS_BETS bets.

import { config } from './config.js';
import { mapLimit } from './http.js';
import { fetchClosedPositions, fetchSportsLeaderboard } from './polymarket.js';
import { leagueOf } from './sports.js';

/** Sports-only track record from a list of closed positions. */
export function sportsStats(closed) {
  const bets = closed.filter((c) => leagueOf(c.eventSlug, c.slug) && c.avgPrice > 0 && c.avgPrice < 1);
  const n = bets.length;
  if (!n) return { sportsBets: 0, winRate: null, avgEntry: null, edge: null, sportsPnl: 0 };
  const wins = bets.filter((b) => b.realizedPnl > 0).length;
  const winRate = wins / n;
  const avgEntry = bets.reduce((s, b) => s + b.avgPrice, 0) / n;
  return {
    sportsBets: n,
    winRate,
    avgEntry,
    edge: winRate - avgEntry,
    sportsPnl: bets.reduce((s, b) => s + b.realizedPnl, 0),
  };
}

/** Rank scored traders: enough history first, then highest edge. */
export function selectTopTraders(scored, { minSportsBets, topTraders }) {
  return scored
    .filter((t) => t.sportsBets >= minSportsBets && t.edge !== null)
    .sort((a, b) => b.edge - a.edge || b.sportsPnl - a.sportsPnl)
    .slice(0, topTraders)
    .map((t, i) => ({ ...t, poolRank: i + 1 }));
}

export async function buildPool(onProgress = () => {}) {
  const leaderboard = await fetchSportsLeaderboard(config.poolSize);
  let done = 0;
  let failures = 0;
  let firstError = null;
  const scored = await mapLimit(leaderboard, 4, async (trader) => {
    let stats;
    try {
      stats = sportsStats(await fetchClosedPositions(trader.wallet));
    } catch (err) {
      failures++;
      firstError ??= err.cause?.message ?? err.message;
      stats = sportsStats([]);
    }
    onProgress(++done, leaderboard.length);
    return { ...trader, ...stats };
  });
  if (failures === leaderboard.length) throw new Error(`Could not load closed positions for any trader: ${firstError}`);
  const selected = selectTopTraders(scored, config);
  return { selected, scoredCount: scored.length, qualifiedCount: scored.filter((t) => t.sportsBets >= config.minSportsBets).length };
}
