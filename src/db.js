// SQLite storage. SQLite is a whole database in a single file
// (data/consensus.db by default), so there is no database server to run.
//
// Tables:
//   trader_pool  today's best sports bettors (rebuilt once a day)
//   meta         small key/value facts (when the pool was built, etc.)
//   snapshots    one row per refresh
//   traders      the selected traders and their stats in that snapshot
//   bets         each consensus bet in that snapshot
//   bet_holders  which traders held each bet, and how much
//   odds_cache   sportsbook odds per sport (saves Odds API credits)

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const SCHEMA_VERSION = 3; // bump when snapshot tables change; those tables are reset

let db;

export function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });
  db = new DatabaseSync(config.dbPath);

  if (db.prepare('PRAGMA user_version').get().user_version !== SCHEMA_VERSION) {
    db.exec(`DROP TABLE IF EXISTS bet_holders; DROP TABLE IF EXISTS bets; DROP TABLE IF EXISTS traders;
             DROP TABLE IF EXISTS snapshots;
             PRAGMA user_version = ${SCHEMA_VERSION};`);
  }

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

    CREATE TABLE IF NOT EXISTS trader_pool (
      wallet TEXT PRIMARY KEY,
      pool_rank INTEGER, lb_rank INTEGER, name TEXT, pnl REAL, volume REAL,
      sports_bets INTEGER, win_rate REAL, avg_entry REAL, edge REAL, sports_pnl REAL
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL,            -- 'ok' or 'error'
      error TEXT,
      traders_count INTEGER,
      eligible_count INTEGER,
      bets_count INTEGER,
      odds_matched INTEGER,
      duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_period ON snapshots(period, created_at);

    CREATE TABLE IF NOT EXISTS traders (
      snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      wallet TEXT NOT NULL,
      rank INTEGER, name TEXT, pnl REAL, volume REAL,
      sports_bets INTEGER, win_rate REAL, avg_entry REAL, edge REAL, weight REAL,
      excluded_reason TEXT, open_value REAL, positions_count INTEGER, hedged_markets INTEGER,
      PRIMARY KEY (snapshot_id, wallet)
    );

    CREATE TABLE IF NOT EXISTS bets (
      snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      condition_id TEXT, outcome TEXT, title TEXT, slug TEXT, event_slug TEXT, end_date TEXT,
      game_start TEXT, league TEXT, sport TEXT, market_type TEXT,
      holders INTEGER, opposing_holders INTEGER, agreement REAL, weighted_agreement REAL, score REAL,
      invested REAL, current_value REAL, avg_entry REAL, cur_price REAL, movement REAL,
      flags TEXT,                      -- JSON array, e.g. ["started"]
      odds_price REAL, odds_book TEXT, odds_team TEXT, odds_event_id TEXT, odds_sport_key TEXT,
      odds_updated_at TEXT, pm_odds REAL,
      PRIMARY KEY (snapshot_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_bets_key ON bets(key);

    CREATE TABLE IF NOT EXISTS odds_cache (sport_key TEXT PRIMARY KEY, fetched_at INTEGER, body TEXT);

    CREATE TABLE IF NOT EXISTS bet_holders (
      snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      bet_key TEXT NOT NULL,
      wallet TEXT NOT NULL,
      size REAL, avg_price REAL, initial_value REAL, current_value REAL, cash_pnl REAL,
      PRIMARY KEY (snapshot_id, bet_key, wallet)
    );
  `);
  return db;
}

function transaction(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const out = fn(d);
    d.exec('COMMIT');
    return out;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

// ---------- Meta ----------

export function getMeta(key) {
  return getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

export function setMeta(key, value) {
  getDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// ---------- Trader pool ----------

export function savePool({ selected, scoredCount, qualifiedCount }) {
  transaction((d) => {
    d.exec('DELETE FROM trader_pool');
    const ins = d.prepare('INSERT INTO trader_pool VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    for (const t of selected) {
      ins.run(t.wallet, t.poolRank, t.rank, t.name, t.pnl, t.volume, t.sportsBets, t.winRate, t.avgEntry, t.edge, t.sportsPnl);
    }
  });
  setMeta('pool_built_at', new Date().toISOString());
  setMeta('pool_scored', scoredCount);
  setMeta('pool_qualified', qualifiedCount);
}

/** The saved pool, in the shape the analysis expects. */
export function loadPool() {
  return getDb().prepare('SELECT * FROM trader_pool ORDER BY pool_rank').all().map((r) => ({
    wallet: r.wallet, rank: r.pool_rank, lbRank: r.lb_rank, name: r.name, pnl: r.pnl, volume: r.volume,
    sportsBets: r.sports_bets, winRate: r.win_rate, avgEntry: r.avg_entry, edge: r.edge, sportsPnl: r.sports_pnl,
  }));
}

// ---------- Snapshots ----------

/** Save one completed analysis as a snapshot. Returns the snapshot id. */
export function saveSnapshot(period, { bets, traders, eligibleCount }, meta) {
  return transaction((d) => {
    const { lastInsertRowid: id } = d
      .prepare(`INSERT INTO snapshots (period, created_at, status, traders_count, eligible_count, bets_count, odds_matched, duration_ms)
                VALUES (?, ?, 'ok', ?, ?, ?, ?, ?)`)
      .run(period, new Date().toISOString(), traders.length, eligibleCount, bets.length, meta.oddsMatched ?? 0, meta.durationMs ?? 0);

    const insTrader = d.prepare(`INSERT INTO traders VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const t of traders) {
      insTrader.run(id, t.wallet, t.rank, t.name, t.pnl, t.volume, t.sportsBets ?? null, t.winRate ?? null,
        t.avgEntry ?? null, t.edge ?? null, t.weight, t.excludedReason, t.openValue, t.positionsCount, t.hedgedMarkets);
    }

    const insBet = d.prepare(`INSERT INTO bets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insHolder = d.prepare(`INSERT INTO bet_holders VALUES (?,?,?,?,?,?,?,?)`);
    for (const b of bets) {
      const o = b.odds;
      insBet.run(id, b.key, b.conditionId, b.outcome, b.title, b.slug, b.eventSlug, b.endDate,
        b.gameStart ?? null, b.league ?? null, b.sport ?? null, b.marketType ?? null,
        b.holders, b.opposingHolders, b.agreement, b.weightedAgreement, b.score,
        b.invested, b.currentValue, b.avgEntry, b.curPrice, b.movement, JSON.stringify(b.flags),
        o?.price ?? null, o?.book ?? null, o?.team ?? null, o?.eventId ?? null, o?.sportKey ?? null,
        o?.updatedAt ?? null, b.pmOdds ?? null);
      for (const h of b.holderRows) {
        insHolder.run(id, b.key, h.wallet, h.size, h.avgPrice, h.initialValue, h.currentValue, h.cashPnl);
      }
    }
    return Number(id);
  });
}

export function saveFailure(period, error, durationMs) {
  getDb()
    .prepare(`INSERT INTO snapshots (period, created_at, status, error, duration_ms) VALUES (?, ?, 'error', ?, ?)`)
    .run(period, new Date().toISOString(), String(error).slice(0, 1000), durationMs);
}

export function latestSnapshot(period) {
  return getDb()
    .prepare(`SELECT * FROM snapshots WHERE period = ? AND status = 'ok' ORDER BY id DESC LIMIT 1`)
    .get(period);
}

export function lastAttempt(period) {
  return getDb().prepare(`SELECT * FROM snapshots WHERE period = ? ORDER BY id DESC LIMIT 1`).get(period);
}

const parseBet = (row) => row && { ...row, flags: JSON.parse(row.flags || '[]') };

export function getBets(snapshotId) {
  return getDb().prepare(`SELECT * FROM bets WHERE snapshot_id = ? ORDER BY score DESC, invested DESC`).all(snapshotId).map(parseBet);
}

export function getBet(snapshotId, key) {
  const d = getDb();
  const bet = parseBet(d.prepare(`SELECT * FROM bets WHERE snapshot_id = ? AND key = ?`).get(snapshotId, key));
  if (!bet) return null;
  bet.holderList = d
    .prepare(`SELECT h.*, t.rank, t.name, t.pnl, t.sports_bets, t.win_rate, t.avg_entry AS trader_avg_entry, t.edge,
                     t.weight, t.open_value, t.positions_count
              FROM bet_holders h JOIN traders t ON t.snapshot_id = h.snapshot_id AND t.wallet = h.wallet
              WHERE h.snapshot_id = ? AND h.bet_key = ? ORDER BY h.initial_value DESC`)
    .all(snapshotId, key);
  return bet;
}

/** How one bet's consensus and prices changed across snapshots. */
export function betHistory(period, key, days = 2) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  return getDb()
    .prepare(`SELECT s.created_at, s.eligible_count, b.holders, b.agreement, b.score, b.cur_price, b.odds_price, b.invested
              FROM snapshots s LEFT JOIN bets b ON b.snapshot_id = s.id AND b.key = ?
              WHERE s.period = ? AND s.status = 'ok' AND s.created_at >= ?
              ORDER BY s.created_at`)
    .all(key, period, since);
}

export function getTraders(snapshotId) {
  return getDb().prepare(`SELECT * FROM traders WHERE snapshot_id = ? ORDER BY rank`).all(snapshotId);
}

/**
 * Keep the database small: drop whole snapshots after `days`, and the bulky
 * per-trader holder rows after `holderDays` (the history chart only needs
 * the bet-level rows).
 */
export function pruneOld(days, holderDays = 3) {
  const d = getDb();
  const ago = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
  d.prepare(`DELETE FROM bet_holders WHERE snapshot_id IN (SELECT id FROM snapshots WHERE created_at < ?)`).run(ago(holderDays));
  return d.prepare(`DELETE FROM snapshots WHERE created_at < ?`).run(ago(days)).changes;
}
