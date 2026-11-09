// The refresh job. One run:
//   1. If the trader pool is missing or older than POOL_MAX_AGE_HOURS, rebuild
//      it (top sports bettors by "win rate above expected"; see pool.js).
//      This takes a few minutes, so it only happens about once a day.
//   2. Fetch open positions for the selected traders.
//   3. Look up those markets on Gamma and keep only sports games that start
//      today (New York time).
//   4. Analyse, then attach sportsbook odds (The Odds API, within budget).
//   5. Save a snapshot.
//
// Run it by hand with `npm run refresh`, or let the server's scheduler run it.

import { pathToFileURL } from 'node:url';
import { analyze } from './analysis.js';
import { config } from './config.js';
import { getMeta, loadPool, pruneOld, saveFailure, savePool, saveSnapshot } from './db.js';
import { clearCache, mapLimit } from './http.js';
import { loadOdds, matchOdds, pmOdds } from './odds.js';
import { buildPool } from './pool.js';
import { fetchMarkets, fetchPositions, resetSortVariant } from './polymarket.js';
import { gameStatus, leagueOf, loadLeagueCodes, parseTime, sportFamily } from './sports.js';

export const status = { running: false, step: null, startedAt: null, lastError: null };

const PERIOD = config.periods[0];
const log = (...args) => console.log(`[refresh ${new Date().toISOString()}]`, ...args);

function poolIsStale() {
  const builtAt = getMeta('pool_built_at');
  return !builtAt || Date.now() - Date.parse(builtAt) > config.poolMaxAgeHours * 3_600_000 || loadPool().length === 0;
}

// A position whose market might be a game today: a sports slug and an end
// date within a few days (game markets end shortly after the game).
function maybeToday(p, now) {
  if (!leagueOf(p.eventSlug, p.slug)) return false;
  const end = parseTime(p.endDate);
  return end === null || (end > now - 2 * 86_400_000 && end < now + 4 * 86_400_000);
}

export async function runRefresh({ forcePool = false } = {}) {
  if (status.running) {
    log('already running, skipping');
    return { skipped: true };
  }
  Object.assign(status, { running: true, startedAt: new Date().toISOString(), lastError: null });
  const started = Date.now();
  clearCache();

  try {
    await loadLeagueCodes();

    // 1. Trader pool (daily)
    if (forcePool || poolIsStale()) {
      status.step = 'ranking sports bettors';
      resetSortVariant();
      log(`rebuilding trader pool from the top ${config.poolSize} sports traders…`);
      try {
        const pool = await buildPool((done, total) => { status.step = `ranking sports bettors (${done}/${total})`; });
        savePool(pool);
        log(`pool: ${pool.qualifiedCount} of ${pool.scoredCount} had ${config.minSportsBets}+ sports bets; kept ${pool.selected.length}`);
      } catch (err) {
        // Keep going with yesterday's traders rather than showing nothing.
        if (!loadPool().length) throw err;
        log(`pool rebuild failed (${err.cause?.message ?? err.message}); using the previous ranking`);
      }
    }
    const traders = loadPool();
    if (!traders.length) throw new Error(`No trader had ${config.minSportsBets}+ resolved sports bets`);

    // 2. Positions
    const now = Date.now();
    status.step = `positions (0/${traders.length})`;
    const positions = new Map();
    let done = 0;
    await mapLimit(traders, 4, async (t) => {
      try {
        positions.set(t.wallet, await fetchPositions(t.wallet));
      } catch (err) {
        log(`positions failed for ${t.wallet}: ${err.message}`);
        positions.set(t.wallet, []);
      }
      status.step = `positions (${++done}/${traders.length})`;
    });

    // 3. Gamma: only markets that could be today's games
    status.step = 'markets';
    const candidates = [...positions.values()].flat().filter((p) => maybeToday(p, now));
    const markets = await fetchMarkets(candidates.map((p) => p.conditionId));
    const slugByCondition = new Map(candidates.map((p) => [p.conditionId, p]));
    let today = 0;
    for (const [id, m] of markets) {
      const p = slugByCondition.get(id);
      m.league = leagueOf(m.eventSlug, m.slug, p?.eventSlug, p?.slug);
      m.sport = sportFamily(m.league);
      m.gameStartMs = parseTime(m.gameStartTime);
      m.gameStatus = m.league ? gameStatus(m.gameStartMs, now) : 'not_sports';
      if (m.gameStatus === 'upcoming' || m.gameStatus === 'started') today++;
    }
    log(`gamma: ${markets.size} candidate markets, ${today} are games today`);

    // 4. Analyse, then sportsbook odds
    status.step = 'analysis';
    const result = analyze({ traders, positions, markets, cfg: config });
    status.step = 'odds';
    const leagueCounts = new Map();
    for (const b of result.bets) if (!b.flags.length) leagueCounts.set(b.league, (leagueCounts.get(b.league) ?? 0) + 1);
    let eventsBySport = new Map();
    try {
      eventsBySport = await loadOdds(leagueCounts);
    } catch (err) {
      log(`odds failed (continuing with Polymarket odds): ${err.message}`);
    }
    let matched = 0;
    for (const bet of result.bets) {
      bet.pmOdds = pmOdds(bet.curPrice);
      bet.odds = matchOdds(bet, eventsBySport);
      if (bet.odds) matched++;
    }
    log(config.oddsApiKey
      ? `odds: sportsbook prices for ${matched} of ${result.bets.length} bets`
      : 'odds: no ODDS_API_KEY set, using Polymarket odds');

    // 5. Save
    const id = saveSnapshot(PERIOD, result, { oddsMatched: matched, durationMs: Date.now() - started });
    log(`saved snapshot ${id} with ${result.bets.length} bets`);

    const pruned = pruneOld(config.retentionDays);
    if (pruned) log(`pruned ${pruned} old snapshots`);
    log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return { snapshotId: id, bets: result.bets.length };
  } catch (err) {
    status.lastError = err.cause?.message ?? err.message;
    log(`FAILED: ${status.lastError}`);
    saveFailure(PERIOD, status.lastError, Date.now() - started);
    throw err;
  } finally {
    Object.assign(status, { running: false, step: null });
  }
}

// `node src/refresh.js` -> run once and exit. Add --pool to force a pool rebuild.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRefresh({ forcePool: process.argv.includes('--pool') })
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
