// End-to-end test of the refresh job with a fake `fetch`, so it runs offline.
// The fake responses mimic Polymarket Data API v2 ({ data, pagination }),
// Gamma's /markets and /sports, and The Odds API.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.PM_DATA_RPS = process.env.PM_GAMMA_RPS = '1000';
process.env.ODDS_API_KEY = 'secret-test-key';
process.env.POOL_SIZE = '12';
process.env.TOP_TRADERS = '8';
process.env.MIN_SPORTS_BETS = '30';

const { localDate } = await import('../src/sports.js');

// A game starting in two minutes (always "today" and "not started yet").
const START = Date.now() + 120_000;
const DAY = localDate(START); // YYYY-MM-DD in New York
const SLUG = `nba-lal-bos-${DAY}`;
const wallets = Array.from({ length: 12 }, (_, i) => `0x${String(i).padStart(40, '0')}`);

const v2 = (data, has_more = false) => ({ data, pagination: { next_cursor: has_more ? 'next' : null, has_more } });
const calls = [];

globalThis.fetch = async (url) => {
  const u = new URL(url);
  calls.push(u.pathname + u.search);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const user = u.searchParams.get('user');
  const i = wallets.indexOf(user);

  if (u.pathname === '/sports') return json([{ sport: 'nba', series: '1' }]);
  if (u.pathname === '/v2/leaderboard') {
    return json(v2(wallets.map((w, k) => ({ rank: k + 1, user_id: w, user_name: `trader${k}`, pnl: 1e5 - k, volume: 1e6 }))));
  }
  if (u.pathname === '/v2/positions' && u.searchParams.get('status') === 'CLOSED') {
    if (u.searchParams.get('sort_by') === 'TIMESTAMP') return json({ error: 'invalid sort_by', code: 'invalid_request' }, 400);
    // Trader i wins (40 + i) of 60 bets bought at 50¢ -> higher i = higher edge.
    // Traders 0-3 have only 20 sports bets (below the minimum).
    const n = i < 4 ? 20 : 60;
    let rows = Array.from({ length: n }, (_, k) => ({
      status: 'CLOSED', event_slug: `fifwc-x-y-2026-0${1 + (k % 9)}-10`, avg_price: 0.5, realized_pnl: k < 40 + i - (60 - n) ? 10 : -10, last_event_at: 2e9 - k,
    }));
    // Like the real API, the default order is biggest profit first.
    if (u.searchParams.get('sort_by') !== 'LAST_EVENT_AT') rows = rows.sort((a, b) => b.realized_pnl - a.realized_pnl).map((r, k) => ({ ...r, last_event_at: 1e9 + (k % 2) * 5e8 }));
    return json(v2(rows));
  }
  if (u.pathname === '/v2/positions') {
    // Everyone holds Celtics; trader 11 hedges both sides (ignored in that market).
    const p = (outcome, idx) => ({
      proxy_wallet: user, condition_id: 'game1', current_size: 1000, avg_price: 0.55, current_price: 0.58, current_value: 580,
      entry_cost_usdc: 550, status: 'OPEN', redeemable: false, title: 'Lakers vs. Celtics', slug: SLUG, event_slug: SLUG,
      outcome, outcome_index: idx, end_date: new Date(START + 3 * 3_600_000).toISOString(),
    });
    return json(v2(i === 11 ? [p('Celtics', 1), p('Lakers', 0)] : [p('Celtics', 1)]));
  }
  if (u.pathname === '/markets') {
    return json([{ conditionId: 'game1', question: 'Lakers vs. Celtics', slug: SLUG, outcomes: '["Lakers","Celtics"]',
      outcomePrices: '["0.41","0.59"]',
      gameStartTime: new Date(START).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '+00'), sportsMarketType: 'moneyline',
      endDate: new Date(START + 3 * 3_600_000).toISOString(), closed: false, active: true, acceptingOrders: true, events: [{ slug: SLUG }] }]);
  }
  // The Odds API
  if (u.host === 'api.the-odds-api.com') {
    assert.equal(u.searchParams.get('apiKey'), 'secret-test-key');
    if (u.pathname === '/v4/sports') return json([{ key: 'basketball_nba', active: true }]);
    if (u.pathname === '/v4/sports/basketball_nba/odds') {
      return new Response(JSON.stringify([{
        id: 'ev1', sport_key: 'basketball_nba', commence_time: new Date(START).toISOString(),
        home_team: 'Boston Celtics', away_team: 'Los Angeles Lakers',
        bookmakers: [
          { key: 'draftkings', title: 'DraftKings', markets: [{ key: 'h2h', outcomes: [{ name: 'Boston Celtics', price: 1.69 }, { name: 'Los Angeles Lakers', price: 2.25 }] }] },
          { key: 'fanduel', title: 'FanDuel', markets: [{ key: 'h2h', outcomes: [{ name: 'Boston Celtics', price: 1.74 }, { name: 'Los Angeles Lakers', price: 2.18 }] }] },
        ],
      }]), { status: 200, headers: { 'x-requests-remaining': '480', 'x-requests-last': '1' } });
    }
  }
  return json({ error: 'not found' }, 404);
};

test('refresh job: rank traders -> today\'s games -> sportsbook odds -> snapshot', async () => {
  const { runRefresh } = await import('../src/refresh.js');
  const db = await import('../src/db.js');
  const odds = await import('../src/odds.js');

  await runRefresh();

  // Pool: traders 0-3 lack history; the rest ranked by edge (highest i first).
  const pool = db.loadPool();
  assert.equal(pool.length, 8);
  assert.equal(pool[0].wallet, wallets[11]);
  assert.ok(Math.abs(pool[0].edge - (51 / 60 - 0.5)) < 1e-9);
  assert.ok(calls.some((c) => c.includes('status=CLOSED') && c.includes('sort_by=LAST_EVENT_AT')));
  assert.ok(calls.some((c) => c.includes('/v2/leaderboard') && c.includes('category=SPORTS')));

  const snap = db.latestSnapshot('sports');
  assert.equal(snap.eligible_count, 8);
  const bets = db.getBets(snap.id);
  assert.equal(bets.length, 1);
  const [bet] = bets;
  assert.equal(bet.outcome, 'Celtics');
  assert.equal(bet.holders, 7);           // 8 selected, trader 11's hedge ignored
  assert.equal(bet.cur_price, 0.59);
  assert.equal(bet.sport, 'Basketball');
  assert.deepEqual(bet.flags, []);
  // Best price across bookmakers, and the credit counter updated.
  assert.equal(bet.odds_price, 1.74);
  assert.equal(bet.odds_book, 'FanDuel');
  assert.equal(bet.pm_odds, 1.69); // 1 / 0.59
  assert.equal(odds.creditsRemaining(), 480);
  assert.equal(odds.creditsUsedToday(), 1);

  // Second run reuses the pool (no new closed-positions calls).
  const before = calls.filter((c) => c.includes('status=CLOSED')).length;
  await runRefresh();
  assert.equal(calls.filter((c) => c.includes('status=CLOSED')).length, before);
  assert.equal(db.betHistory('sports', bet.key).length, 2);
  // Odds were cached: still only one paid odds request.
  assert.equal(calls.filter((c) => c.startsWith('/v4/sports/basketball_nba/odds')).length, 1);
});
