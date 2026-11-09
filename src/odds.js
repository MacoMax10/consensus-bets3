// Real sportsbook odds from The Odds API (https://the-odds-api.com).
//
// Each request costs 1 credit per sport (h2h market, one region), and the
// free plan has 500 credits a month, so we're careful:
//   - only sports that have bets today are fetched
//   - each sport is cached (in the database) for ODDS_REFRESH_MINUTES
//   - at most ODDS_DAILY_BUDGET credits a day, and never below ODDS_MIN_REMAINING
// The list of sports is free and doesn't use credits.
//
// For every bet we show the best decimal price across the region's
// bookmakers (e.g. 1.75 at FanDuel). Bets with no sportsbook equivalent
// (spreads, props, "Team X does NOT win"...) fall back to Polymarket's price.

import { config } from './config.js';
import { getDb, getMeta, setMeta } from './db.js';
import { buildUrl, getJson } from './http.js';
import { localDate } from './sports.js';

// Polymarket league code -> The Odds API sport key.
const SPORT_KEYS = {
  nba: 'basketball_nba', wnba: 'basketball_wnba', cbb: 'basketball_ncaab', ncaab: 'basketball_ncaab',
  euroleague: 'basketball_euroleague',
  nfl: 'americanfootball_nfl', cfb: 'americanfootball_ncaaf', ncaaf: 'americanfootball_ncaaf',
  mlb: 'baseball_mlb', nhl: 'icehockey_nhl',
  epl: 'soccer_epl', lal: 'soccer_spain_la_liga', bun: 'soccer_germany_bundesliga', sea: 'soccer_italy_serie_a',
  fl1: 'soccer_france_ligue_one', ucl: 'soccer_uefa_champs_league', uel: 'soccer_uefa_europa_league',
  uecl: 'soccer_uefa_europa_conference_league', mls: 'soccer_usa_mls', ere: 'soccer_netherlands_eredivisie',
  por: 'soccer_portugal_primeira_liga', mex: 'soccer_mexico_ligamx', bra: 'soccer_brazil_campeonato',
  arg: 'soccer_argentina_primera_division', tur: 'soccer_turkey_super_league', efl: 'soccer_efl_champ',
  elc: 'soccer_efl_champ', fifwc: 'soccer_fifa_world_cup', wc: 'soccer_fifa_world_cup',
  ufc: 'mma_mixed_martial_arts', mma: 'mma_mixed_martial_arts',
};
export const sportKeyFor = (league) => SPORT_KEYS[league] ?? null;

const url = (path, params = {}) => buildUrl(config.oddsApi, path, { ...params, apiKey: config.oddsApiKey });

// ---------- Budget bookkeeping ----------

const todayKey = () => `odds_used_${localDate(Date.now())}`;
export const creditsUsedToday = () => Number(getMeta(todayKey()) ?? 0);
export const creditsRemaining = () => {
  const v = getMeta('odds_remaining');
  return v === null ? null : Number(v);
};

function canSpend(credits = 1, { ignoreDailyBudget = false } = {}) {
  if (!config.oddsApiKey) return false;
  const remaining = creditsRemaining();
  if (remaining !== null && remaining - credits < config.oddsMinRemaining) return false;
  return ignoreDailyBudget || creditsUsedToday() + credits <= config.oddsDailyBudget;
}

function recordUsage(headers) {
  const last = Number(headers.get('x-requests-last') ?? 1);
  setMeta(todayKey(), creditsUsedToday() + (Number.isFinite(last) ? last : 1));
  const remaining = headers.get('x-requests-remaining');
  if (remaining !== null) setMeta('odds_remaining', Number(remaining));
}

// ---------- Fetching (with a database cache) ----------

/** Active sport keys. Free; cached for 12 hours. */
async function activeSportKeys() {
  const cached = getMeta('odds_sports');
  const at = Number(getMeta('odds_sports_at') ?? 0);
  if (cached && Date.now() - at < 12 * 3_600_000) return new Set(JSON.parse(cached));
  const list = await getJson(url('/sports'));
  const keys = list.filter((s) => s.active !== false).map((s) => s.key);
  setMeta('odds_sports', JSON.stringify(keys));
  setMeta('odds_sports_at', Date.now());
  return new Set(keys);
}

function readCache(sportKey) {
  const row = getDb().prepare('SELECT fetched_at, body FROM odds_cache WHERE sport_key = ?').get(sportKey);
  return row ? { fetchedAt: row.fetched_at, events: JSON.parse(row.body) } : null;
}

function writeCache(sportKey, events) {
  getDb().prepare(`INSERT INTO odds_cache (sport_key, fetched_at, body) VALUES (?, ?, ?)
                   ON CONFLICT(sport_key) DO UPDATE SET fetched_at = excluded.fetched_at, body = excluded.body`)
    .run(sportKey, Date.now(), JSON.stringify(events));
}

async function fetchSport(sportKey) {
  const { body, headers } = await getJson(
    url(`/sports/${sportKey}/odds`, { regions: config.oddsRegions, markets: 'h2h', oddsFormat: 'decimal' }),
    { withHeaders: true },
  );
  recordUsage(headers);
  writeCache(sportKey, body);
  return body;
}

/**
 * Odds events for the given leagues, refreshing stale ones within budget.
 * Sports with the most bets are refreshed first. Returns Map(sportKey -> events).
 */
export async function loadOdds(leagueCounts) {
  const out = new Map();
  if (!config.oddsApiKey) return out;
  let active;
  try {
    active = await activeSportKeys();
  } catch (err) {
    console.warn(`[odds] sports list unavailable: ${err.message}`);
    active = null;
  }
  const wanted = new Map();
  for (const [league, n] of leagueCounts) {
    const key = sportKeyFor(league);
    if (key && (!active || active.has(key))) wanted.set(key, (wanted.get(key) ?? 0) + n);
  }
  const ordered = [...wanted].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  for (const key of ordered) {
    const cached = readCache(key);
    const stale = !cached || Date.now() - cached.fetchedAt > config.oddsRefreshMinutes * 60_000;
    if (stale && canSpend(1)) {
      try {
        out.set(key, await fetchSport(key));
        continue;
      } catch (err) {
        console.warn(`[odds] ${key} failed: ${err.message}`);
      }
    }
    if (cached) out.set(key, cached.events);
  }
  return out;
}

// ---------- Matching a Polymarket bet to a sportsbook price ----------

const ALIASES = { man: 'manchester', utd: 'united', st: 'saint', la: 'los angeles', ny: 'new york' };
const DROP = new Set(['fc', 'cf', 'afc', 'sc', 'the', 'club', 'de', 'cd']);

export function teamTokens(name) {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // é -> e
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .flatMap((t) => (ALIASES[t] ?? t).split(' '))
    .filter((t) => t && !DROP.has(t));
}

/** Does Polymarket's team name refer to this sportsbook name? ("Celtics" ~ "Boston Celtics") */
export function sameTeam(pmName, bookName) {
  const a = teamTokens(pmName);
  const b = teamTokens(bookName);
  if (!a.length || !b.length) return false;
  const inB = a.filter((t) => b.includes(t)).length;
  const inA = b.filter((t) => a.includes(t)).length;
  return inB === a.length || inA === b.length;
}

/** Work out which team (or "Draw") a Polymarket bet is backing, plus the teams in the game. */
export function describeBet({ title, outcome, slug, marketType }) {
  const t = String(title ?? '');
  const o = String(outcome ?? '').trim();
  // Only straight "who wins" bets have a sportsbook moneyline equivalent.
  if (marketType && !/moneyline|h2h|winner|draw/i.test(marketType)) return null;
  if (/spread|o\/u|over\/under|total|handicap|\(\s*[+-]?\d/i.test(t)) return null;
  const isYes = /^yes$/i.test(o);
  const isNo = /^no$/i.test(o);
  const vs = t.split(/\s+(?:vs\.?|v\.?|@|at)\s+/i);
  const teams = vs.length === 2 ? vs.map((s) => s.replace(/[?:].*$/, '').trim()) : [];

  if (/draw/i.test(t) || /-draw$/.test(String(slug ?? ''))) return isYes ? { pick: 'Draw', teams } : null;
  if (!isYes && !isNo) return { pick: o, teams }; // moneyline: outcome is the team name
  const win = /^will (.+?) win\b/i.exec(t);
  if (win && isYes) return { pick: win[1].trim(), teams };
  return null; // "No" on a team-to-win market has no straight sportsbook equivalent
}

/**
 * Best sportsbook price for a bet, or null.
 * @returns {null | { price, book, eventId, sportKey, team, updatedAt }}
 */
export function matchOdds(bet, eventsBySport) {
  const sportKey = sportKeyFor(bet.league);
  const events = sportKey && eventsBySport.get(sportKey);
  if (!events?.length) return null;
  const want = describeBet(bet);
  if (!want) return null;

  const start = bet.gameStart ? Date.parse(bet.gameStart) : null;
  const candidates = events.filter((ev) => {
    const t = Date.parse(ev.commence_time);
    if (start !== null && Math.abs(t - start) > 6 * 3_600_000) return false;
    const names = [ev.home_team, ev.away_team];
    if (want.teams.length === 2 && !want.teams.every((pm) => names.some((n) => sameTeam(pm, n)))) return false;
    return want.pick === 'Draw' || names.some((n) => sameTeam(want.pick, n));
  });
  if (candidates.length !== 1 && !(candidates.length > 1 && start !== null)) return null;
  const ev = start === null ? candidates[0]
    : candidates.sort((a, b) => Math.abs(Date.parse(a.commence_time) - start) - Math.abs(Date.parse(b.commence_time) - start))[0];

  let best = null;
  for (const bk of ev.bookmakers ?? []) {
    const market = (bk.markets ?? []).find((m) => m.key === 'h2h');
    for (const oc of market?.outcomes ?? []) {
      const hit = want.pick === 'Draw' ? /^draw$/i.test(oc.name) : sameTeam(want.pick, oc.name);
      if (hit && oc.price > 1 && (!best || oc.price > best.price)) {
        best = { price: oc.price, book: bk.title, team: oc.name, updatedAt: bk.last_update ?? null };
      }
    }
  }
  return best && { ...best, eventId: ev.id, sportKey };
}

/** Polymarket price -> decimal odds (58¢ -> 1.72). */
export const pmOdds = (price) => (price > 0 && price < 1 ? Math.round((1 / price) * 100) / 100 : null);
