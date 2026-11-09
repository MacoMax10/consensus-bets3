// The web server: serves the dashboard (public/) and a small read-only JSON API,
// and runs the refresh job on a schedule.

import express from 'express';
import cron from 'node-cron';
import { config } from './config.js';
import { betHistory, getBet, getBets, getDb, getMeta, getTraders, lastAttempt, latestSnapshot, loadPool } from './db.js';
import { creditsRemaining, creditsUsedToday } from './odds.js';
import { polymarketUrl } from './polymarket.js';
import { runRefresh, status } from './refresh.js';

const app = express();
const hasBearer = (req) => Boolean(config.refreshToken) && req.get('authorization') === `Bearer ${config.refreshToken}`;

// Optional site password (APP_PASSWORD). The browser shows its own login box.
app.use((req, res, next) => {
  if (!config.appPassword || hasBearer(req)) return next();
  const [scheme, encoded] = (req.get('authorization') ?? '').split(' ');
  const password = scheme === 'Basic' ? Buffer.from(encoded ?? '', 'base64').toString().split(':').slice(1).join(':') : null;
  if (password === config.appPassword) return next();
  res.set('WWW-Authenticate', 'Basic realm="Consensus Bets"').status(401).send('Password required');
});
app.use(express.static('public'));
app.use(express.json());

// Who may start a refresh: your own computer, anyone
// who passed the site password, or a caller with the REFRESH_TOKEN.
const trusted = (req) =>
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || Boolean(config.appPassword) || hasBearer(req);

const periodOf = () => config.periods[0]; // single view: today's sports games
const withLinks = (b) => ({ ...b, polymarket_url: polymarketUrl(b.event_slug, b.slug) });

// Overall status: last update per period, whether a refresh is running, and filter settings.
app.get('/api/status', (req, res) => {
  const periods = {};
  for (const p of config.periods) periods[p] = { latest: latestSnapshot(p) ?? null, lastAttempt: lastAttempt(p) ?? null };
  res.json({
    periods,
    refresh: status,
    schedule: config.runScheduler ? config.refreshCron : 'external',
    odds: {
      enabled: Boolean(config.oddsApiKey),
      remaining: creditsRemaining(),
      usedToday: creditsUsedToday(),
      dailyBudget: config.oddsDailyBudget,
    },
    pool: {
      builtAt: getMeta('pool_built_at'),
      scored: Number(getMeta('pool_scored') ?? 0),
      qualified: Number(getMeta('pool_qualified') ?? 0),
    },
    settings: {
      timeZone: config.timeZone,
      poolSize: config.poolSize,
      minSportsBets: config.minSportsBets,
      topTraders: config.topTraders,
      minPrice: config.minPrice,
      maxPrice: config.maxPrice,
      minPositionUsd: config.minPositionUsd,
      minHoldersStored: config.minHoldersToStore,
      defaultMinTraders: config.defaultMinTraders,
    },
  });
});

// All bets in the latest snapshot for a period. Filtering by agreement happens in the browser.
app.get('/api/bets', (req, res) => {
  const snap = latestSnapshot(periodOf(req));
  if (!snap) return res.json({ snapshot: null, bets: [] });
  res.json({ snapshot: snap, bets: getBets(snap.id).map(withLinks) });
});

// One bet: its holders with their trader stats, plus history over time.
app.get('/api/bet', (req, res) => {
  const period = periodOf(req);
  const snap = latestSnapshot(period);
  const bet = snap && getBet(snap.id, String(req.query.key ?? ''));
  if (!bet) return res.status(404).json({ error: 'Bet not found in the latest snapshot' });
  res.json({ snapshot: snap, bet: withLinks(bet), history: betHistory(period, bet.key, Number(req.query.days) || 2) });
});

app.get('/api/traders', (req, res) => {
  const snap = latestSnapshot(periodOf(req));
  res.json({ snapshot: snap ?? null, traders: snap ? getTraders(snap.id) : [], pool: loadPool() });
});

// Trigger a refresh (the "Refresh now" button, or an external cron with the token).
app.post('/api/refresh', (req, res) => {
  if (!trusted(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (status.running) return res.status(409).json({ error: 'A refresh is already running', status });
  runRefresh().catch(() => {}); // runs in the background; errors are logged and saved
  res.status(202).json({ started: true });
});

getDb(); // create tables on startup

app.listen(config.port, () => {
  console.log(`Consensus Bets running at http://localhost:${config.port}`);

  if (config.runScheduler) {
    cron.schedule(config.refreshCron, () => runRefresh().catch(() => {}));
    console.log(`Scheduler on: "${config.refreshCron}"`);

    // Refresh right away if we have no data yet or the last snapshot is stale.
    const latest = latestSnapshot(periodOf());
    const ageMin = latest ? (Date.now() - new Date(latest.created_at)) / 60_000 : Infinity;
    if (ageMin > 10) runRefresh().catch(() => {});
  }
});
