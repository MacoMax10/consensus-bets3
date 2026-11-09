// Polymarket public APIs (read-only, no API key, no wallet):
//
//   Data API  (data-api.polymarket.com)  -> leaderboard, positions
//   Gamma API (gamma-api.polymarket.com) -> market metadata & live prices
//
// Data API v1 was retired on 2026-10-24. v2 differs in four ways:
//   - routes live under /v2
//   - responses are wrapped: { data: [...], pagination: { next_cursor, has_more } }
//   - pagination is cursor-based (`offset` is rejected)
//   - fields are snake_case, with a few renames (leaderboard proxyWallet -> user_id,
//     positions size -> current_size, curPrice -> current_price, ...)
// The normalize* functions below accept both the old and new names, so a
// small API change doesn't break the app.

import { config } from './config.js';
import { buildUrl, getJson, HttpError } from './http.js';

const pick = (obj, ...keys) => {
  for (const k of keys) if (obj?.[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
};
const toNum = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const unwrap = (body) => (Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : []);

// ---------- Leaderboard ----------

export function normalizeTrader(row) {
  const pnl = toNum(pick(row, 'pnl', 'profit')) ?? 0;
  const volume = toNum(pick(row, 'volume', 'vol')) ?? 0;
  return {
    wallet: String(pick(row, 'user_id', 'proxy_wallet', 'proxyWallet', 'wallet') ?? '').toLowerCase(),
    rank: toNum(pick(row, 'rank')),
    name: pick(row, 'user_name', 'userName', 'name', 'pseudonym') || null,
    pnl,
    volume,
  };
}

/**
 * Top traders by all-time profit in the Sports category.
 * The v2 docs and real-world clients disagree on parameter casing
 * (timePeriod vs time_period), so we try both styles.
 */
export async function fetchSportsLeaderboard(limit = config.poolSize) {
  const pageSize = Math.min(50, limit); // the API serves at most 50 per page
  const attempts = [
    { timePeriod: 'ALL', orderBy: 'PNL', category: 'SPORTS', limit: pageSize },
    { time_period: 'all', order_by: 'pnl', category: 'sports', limit: pageSize },
  ];
  let lastErr;
  for (const params of attempts) {
    try {
      const traders = [];
      let cursor;
      do {
        const body = await getJson(buildUrl(config.polymarketDataApi, '/v2/leaderboard', { ...params, cursor }), { ttlMs: 10 * 60_000 });
        traders.push(...unwrap(body).map(normalizeTrader).filter((t) => t.wallet));
        cursor = body?.pagination?.has_more ? body.pagination.next_cursor : null;
      } while (cursor && traders.length < limit);
      if (traders.length) return traders.slice(0, limit);
    } catch (err) {
      lastErr = err;
      if (!(err instanceof HttpError && err.status === 400)) throw err;
    }
  }
  throw lastErr ?? new Error('Sports leaderboard returned no traders');
}

// ---------- Positions ----------

export function normalizePosition(row) {
  const size = toNum(pick(row, 'current_size', 'size')) ?? 0;
  const avgPrice = toNum(pick(row, 'avg_price', 'avgPrice')) ?? 0;
  return {
    wallet: String(pick(row, 'proxy_wallet', 'proxyWallet') ?? '').toLowerCase(),
    conditionId: pick(row, 'condition_id', 'conditionId'),
    outcome: pick(row, 'outcome') ?? '',
    outcomeIndex: toNum(pick(row, 'outcome_index', 'outcomeIndex')),
    oppositeOutcome: pick(row, 'opposite_outcome', 'oppositeOutcome') ?? null,
    size,
    avgPrice,
    curPrice: toNum(pick(row, 'current_price', 'cur_price', 'curPrice')),
    initialValue: toNum(pick(row, 'entry_cost_usdc', 'initial_value', 'initialValue')) ?? size * avgPrice,
    currentValue: toNum(pick(row, 'current_value', 'currentValue')),
    cashPnl: toNum(pick(row, 'unrealized_pnl', 'cash_pnl', 'cashPnl')),
    title: pick(row, 'title') ?? '',
    slug: pick(row, 'slug') ?? null,
    eventSlug: pick(row, 'event_slug', 'eventSlug') ?? null,
    endDate: pick(row, 'end_date', 'endDate') ?? null,
    redeemable: Boolean(pick(row, 'redeemable')),
    status: pick(row, 'status') ?? null,
  };
}

/** All open positions for one wallet, following the pagination cursor. */
let positionsPageSize = 500; // drops to 100 if the API rejects 500

export async function fetchPositions(wallet) {
  const out = [];
  let cursor;
  for (let page = 0; page < config.maxPositionPagesPerTrader; page++) {
    let body;
    try {
      body = await getJson(buildUrl(config.polymarketDataApi, '/v2/positions', { user: wallet, limit: positionsPageSize, cursor }));
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 400 && positionsPageSize > 100)) throw err;
      positionsPageSize = 100;
      page--;
      continue;
    }
    out.push(...unwrap(body).map(normalizePosition));
    cursor = body?.pagination?.next_cursor;
    if (!cursor || !body?.pagination?.has_more) break;
  }
  // Keep only live positions: resolved markets show up as "redeemable".
  return out.filter((p) => p.conditionId && p.size > 0 && !p.redeemable && (!p.status || p.status === 'OPEN'));
}

// ---------- Closed (resolved) positions ----------

export function normalizeClosed(row) {
  return {
    conditionId: pick(row, 'condition_id', 'conditionId'),
    slug: pick(row, 'slug') ?? null,
    eventSlug: pick(row, 'event_slug', 'eventSlug') ?? null,
    title: pick(row, 'title') ?? '',
    avgPrice: toNum(pick(row, 'avg_price', 'avgPrice')),
    realizedPnl: toNum(pick(row, 'realized_pnl', 'realizedPnl')) ?? 0,
    totalBought: toNum(pick(row, 'total_bought', 'totalBought')),
    timestamp: toNum(pick(row, 'last_event_at', 'timestamp', 'closed_at')),
  };
}

// In Data API v2 there is no /closed-positions; closed bets come from
// /v2/positions?status=CLOSED. We want the most recent ones, so we ask for
// newest-first and remember which spelling the API accepts. If none works
// and the default order isn't by date (e.g. biggest profit first, which
// would make every trader look brilliant), we read more pages instead.
const SORT_VARIANTS = [
  { sort_by: 'LAST_EVENT_AT', sort_direction: 'DESC' },
  { sort_by: 'TIMESTAMP', sort_direction: 'DESC' },
  {}, // default order
];
let sortVariant = null;

const isNewestFirst = (rows) => rows.every((r, i) => i === 0 || r.timestamp === null || rows[i - 1].timestamp === null || rows[i - 1].timestamp >= r.timestamp);

async function readClosedPages(wallet, variant, maxPages) {
  const out = [];
  let cursor;
  for (let page = 0; page < maxPages; page++) {
    const body = await getJson(buildUrl(config.polymarketDataApi, '/v2/positions', { user: wallet, status: 'CLOSED', limit: 50, ...variant, cursor }));
    out.push(...unwrap(body).map(normalizeClosed));
    cursor = body?.pagination?.has_more ? body.pagination.next_cursor : null;
    if (!cursor) break;
    // Unsorted default order: read extra pages so the sample isn't just the top of a biased list.
    if (page === 0 && !Object.keys(variant).length && !isNewestFirst(out)) maxPages = config.closedPagesPerTrader * 3;
  }
  return out;
}

/** A trader's most recent closed positions (about CLOSED_PAGES x 50). */
export async function fetchClosedPositions(wallet) {
  const variants = sortVariant ? [sortVariant] : SORT_VARIANTS;
  let lastErr;
  for (const variant of variants) {
    try {
      const out = await readClosedPages(wallet, variant, config.closedPagesPerTrader);
      // A sort option that's accepted but ignored is no good.
      if (Object.keys(variant).length && out.length > 1 && !isNewestFirst(out)) continue;
      if (!sortVariant && out.length > 1) sortVariant = variant;
      return out;
    } catch (err) {
      lastErr = err;
      if (!(err instanceof HttpError && err.status === 400)) throw err;
    }
  }
  throw lastErr ?? new Error('closed positions unavailable');
}

export function resetSortVariant() {
  sortVariant = null;
}

// ---------- Gamma: market metadata ----------

const parseJsonArray = (v) => {
  if (Array.isArray(v)) return v;
  try { return JSON.parse(v ?? '[]'); } catch { return []; }
};

export function normalizeMarket(m) {
  const outcomes = parseJsonArray(m.outcomes);
  const prices = parseJsonArray(m.outcomePrices).map(Number);
  return {
    conditionId: m.conditionId,
    question: m.question ?? '',
    slug: m.slug ?? null,
    eventSlug: m.events?.[0]?.slug ?? null,
    eventTitle: m.events?.[0]?.title ?? null,
    endDate: m.endDate ?? m.endDateIso ?? null,
    // Sports games: when the game starts (falls back to the event's start).
    gameStartTime: m.gameStartTime ?? m.eventStartTime ?? m.events?.[0]?.startTime ?? null,
    sportsMarketType: m.sportsMarketType ?? m.sports_market_type ?? null,
    closed: Boolean(m.closed),
    active: m.active !== false,
    acceptingOrders: m.acceptingOrders !== false,
    outcomes,
    prices,
    volume: toNum(m.volumeNum ?? m.volume),
    liquidity: toNum(m.liquidityNum ?? m.liquidity),
  };
}

/** Look up many markets by condition id, 25 per request. Returns a Map. */
export async function fetchMarkets(conditionIds, extraParams = {}) {
  const map = new Map();
  const ids = [...new Set(conditionIds)];
  for (let i = 0; i < ids.length; i += 25) {
    const batch = ids.slice(i, i + 25);
    try {
      const body = await getJson(
        buildUrl(config.polymarketGammaApi, '/markets', { condition_ids: batch, limit: batch.length, ...extraParams }),
        { ttlMs: 10 * 60_000 },
      );
      for (const m of unwrap(body)) map.set(m.conditionId, normalizeMarket(m));
    } catch (err) {
      // Not fatal: positions already carry title/price/end date.
      console.warn(`[gamma] batch ${i / 25 + 1} failed: ${err.message}`);
    }
  }
  return map;
}

export const polymarketUrl = (eventSlug, slug) =>
  eventSlug ? `https://polymarket.com/event/${eventSlug}${slug && slug !== eventSlug ? `/${slug}` : ''}` : null;
