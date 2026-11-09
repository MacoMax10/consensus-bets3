// Sports helpers: is a market a sports bet, which sport is it, and does the
// game start later today (New York time)?
//
// Polymarket game markets have slugs like "nba-lal-bos-2026-10-29" or
// "epl-ars-che-2026-10-29": a league code, the teams, then the game date.
// Gamma's GET /sports lists every league code Polymarket uses, so we fetch
// that list and fall back to a built-in one if it's unavailable.

import { config } from './config.js';
import { buildUrl, getJson } from './http.js';

// League code -> sport family, for the dashboard's sport filter.
const FAMILY = {
  Basketball: ['nba', 'wnba', 'cbb', 'ncaab', 'cwbb', 'euroleague', 'bkl', 'nbl', 'acb', 'bbl', 'kbl', 'cba'],
  Soccer: ['fifwc', 'wc', 'fifa', 'uefa', 'euro', 'epl', 'lal', 'bun', 'sea', 'fl1', 'ucl', 'uel', 'uecl', 'mls', 'ere', 'por', 'arg', 'bra', 'mex', 'tur',
    'spl', 'efl', 'elc', 'fac', 'cdr', 'dfb', 'cof', 'jap', 'kor', 'aus', 'fif', 'wcq', 'cwc', 'con', 'lib', 'sud',
    'nwsl', 'scop', 'bel', 'den', 'nor', 'swe', 'aut', 'sui', 'gre', 'rus', 'ind', 'chn', 'soccer', 'football-soccer'],
  'American football': ['nfl', 'cfb', 'ncaaf', 'ufl', 'cfl'],
  Baseball: ['mlb', 'kbo', 'npb', 'cbs'],
  Hockey: ['nhl', 'khl', 'shl', 'ahl'],
  Tennis: ['atp', 'wta', 'tennis'],
  'MMA / Boxing': ['ufc', 'mma', 'boxing', 'pfl'],
  Cricket: ['ipl', 'cricket', 'odi', 't20', 'test'],
  Esports: ['cs2', 'csgo', 'lol', 'dota2', 'val', 'esports'],
  Golf: ['pga', 'golf', 'liv'],
};
const CODE_TO_FAMILY = new Map(Object.entries(FAMILY).flatMap(([fam, codes]) => codes.map((c) => [c, fam])));

let leagueCodes = new Set(CODE_TO_FAMILY.keys());

/** Load Polymarket's league list once per refresh (merged with the built-in list). */
export async function loadLeagueCodes() {
  try {
    const body = await getJson(buildUrl(config.polymarketGammaApi, '/sports'), { ttlMs: 24 * 3_600_000 });
    const rows = Array.isArray(body) ? body : body?.data ?? [];
    for (const r of rows) if (r?.sport) leagueCodes.add(String(r.sport).toLowerCase());
  } catch (err) {
    console.warn(`[sports] /sports unavailable, using built-in league list: ${err.message}`);
  }
  return leagueCodes;
}

// "league-team1-team2-YYYY-MM-DD", optionally followed by one more part
// ("-ger", "-draw", "-spread-home-2pt5"...). This shape is used for every
// game on Polymarket, so it also catches leagues we don't know by name.
const GAME_SLUG = /^([a-z0-9]+)-[a-z0-9]+-[a-z0-9]+-\d{4}-\d{2}-\d{2}(?:-[a-z0-9-]+)?$/;
const NOT_SPORTS = new Set(['btc', 'eth', 'sol', 'xrp', 'bitcoin', 'ethereum', 'solana', 'will', 'fed', 'cpi']);

/** League code of a market from its slug(s), or null if it isn't a sports market. */
export function leagueOf(...slugs) {
  for (const slug of slugs) {
    if (!slug) continue;
    const s = String(slug).toLowerCase();
    const m = GAME_SLUG.exec(s);
    if (m && !NOT_SPORTS.has(m[1])) return m[1];
    const prefix = s.split('-')[0];
    if (leagueCodes.has(prefix)) return prefix;
  }
  return null;
}

export const sportFamily = (league) => (league ? CODE_TO_FAMILY.get(league) ?? 'Other sports' : null);

/** Parse Gamma timestamps like "2026-10-29 23:00:00+00" as well as ISO strings. */
export function parseTime(v) {
  if (!v) return null;
  let s = String(v).trim().replace(' ', 'T');
  s = s.replace(/([+-]\d\d)$/, '$1:00'); // "+00" -> "+00:00"
  if (/T\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(s)) s += 'Z'; // no zone -> UTC
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** "YYYY-MM-DD" for a timestamp in the configured time zone (New York by default). */
export function localDate(ms, timeZone = config.timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
}

/** Today's game: starts on today's local date and hasn't started yet. */
export function gameStatus(startMs, now = Date.now()) {
  if (startMs === null) return 'unknown';
  if (localDate(startMs) !== localDate(now)) return 'not_today';
  return startMs <= now ? 'started' : 'upcoming';
}
