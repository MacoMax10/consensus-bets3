// Every tunable setting lives here. Each one can be overridden with an
// environment variable (e.g. `MIN_PRICE=0.1 npm start`) so you can change
// behaviour on your host without editing code.

const num = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : Number(v);
};

export const config = {
  // --- Server ---
  port: num('PORT', 3000),
  dbPath: process.env.DB_PATH || './data/consensus.db',

  // --- Schedule ---
  // Standard cron syntax: "every 10 minutes" (same-day sports prices move fast).
  refreshCron: process.env.REFRESH_CRON || '*/10 * * * *',
  // Set to "false" if an external scheduler (e.g. Railway cron) runs `npm run refresh`.
  runScheduler: process.env.RUN_SCHEDULER !== 'false',
  // Optional secret that lets an external cron hit POST /api/refresh.
  refreshToken: process.env.REFRESH_TOKEN || '',
  // Optional password for the whole site (recommended once it's online; the
  // Refresh button only works for people who entered it). Any username works.
  appPassword: process.env.APP_PASSWORD || '',
  // Delete snapshots older than this many days to keep the database small.
  retentionDays: num('RETENTION_DAYS', 30),

  // --- API hosts (public, no keys needed) ---
  polymarketDataApi: process.env.PM_DATA_API || 'https://data-api.polymarket.com',
  polymarketGammaApi: process.env.PM_GAMMA_API || 'https://gamma-api.polymarket.com',
  oddsApi: process.env.ODDS_API || 'https://api.the-odds-api.com/v4',

  // --- Rate limits (requests per second, per host). Polymarket documents
  // 150 req / 10 s on /positions; we stay well under that.
  rateLimits: {
    'data-api.polymarket.com': num('PM_DATA_RPS', 8),
    'gamma-api.polymarket.com': num('PM_GAMMA_RPS', 5),
    'api.the-odds-api.com': 2,
  },
  defaultRps: 4,

  // --- Trader pool (rebuilt once a day) ---
  // 1. Take the top POOL_SIZE traders from Polymarket's Sports leaderboard (by profit).
  // 2. Score each on their recent resolved sports bets.
  // 3. Keep the best TOP_TRADERS by "win rate above expected".
  poolSize: num('POOL_SIZE', 500),
  topTraders: num('TOP_TRADERS', 200),
  minSportsBets: num('MIN_SPORTS_BETS', 30),        // need this many resolved sports bets
  closedPagesPerTrader: num('CLOSED_PAGES', 4),     // 4 x 50 = last 200 closed bets
  poolMaxAgeHours: num('POOL_MAX_AGE_HOURS', 24),
  maxPositionPagesPerTrader: num('MAX_POSITION_PAGES', 4), // 4 x 500 = 2000 positions

  // --- Games ---
  // "Today" means today in this time zone.
  timeZone: process.env.TIME_ZONE || 'America/New_York',
  // Only one view now; kept as a name so snapshots are labelled.
  periods: ['sports'],

  // --- Filters ---
  minPrice: num('MIN_PRICE', 0.05),   // exclude outcomes priced below 5¢
  maxPrice: num('MAX_PRICE', 0.90),   // exclude outcomes priced above 90¢
  minPositionUsd: num('MIN_POSITION_USD', 50), // ignore dust positions
  // A trader holding both sides of a market is excluded from that market.
  // If they do it in at least this share of their markets, they're treated as
  // a market maker and excluded entirely.
  marketMakerHedgeShare: num('MM_HEDGE_SHARE', 0.2),
  marketMakerMinHedges: num('MM_MIN_HEDGES', 3),

  // Bets with fewer holders than this aren't saved (keeps the DB small).
  // The dashboard's "min. traders agreeing" slider then filters what you see.
  minHoldersToStore: num('MIN_HOLDERS_TO_STORE', 2),
  defaultMinTraders: num('DEFAULT_MIN_TRADERS', 2),

  // --- Sportsbook odds (The Odds API, https://the-odds-api.com) ---
  // Free key: 500 credits/month. Each request = 1 credit per sport.
  oddsApiKey: process.env.ODDS_API_KEY || '',
  oddsRegions: process.env.ODDS_REGIONS || 'us',        // us = DraftKings, FanDuel, BetMGM, ...
  oddsRefreshMinutes: num('ODDS_REFRESH_MINUTES', 60),  // re-fetch a sport's odds at most this often
  oddsDailyBudget: num('ODDS_DAILY_BUDGET', 15),        // credits per day (15 x 30 = 450 of the free 500)
  oddsMinRemaining: num('ODDS_MIN_REMAINING', 10),      // stop when the month's credits run this low
};
