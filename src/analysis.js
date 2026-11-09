// The analysis is a pure function: data in, scored bets out. It never calls
// the network, which makes it easy to test (see test/analysis.test.js).

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * How much each trader's vote counts, from 0.5 (weakest) to 1.0 (strongest),
 * based on their sports edge (win rate minus average price paid; see pool.js).
 * An edge of +15 points or more earns full weight.
 */
export function traderWeight({ edge }) {
  return 0.5 + 0.5 * clamp((edge ?? 0) / 0.15, 0, 1);
}

const positionValue = (p) => p.currentValue ?? p.size * (p.curPrice ?? p.avgPrice);

/**
 * @param {object} input
 * @param {Array}  input.traders     selected traders (+ edge, winRate)
 * @param {Map}    input.positions   wallet -> normalized positions
 * @param {Map}    input.markets     conditionId -> Gamma market (+ gameStatus, league, sport)
 * @param {object} input.cfg         config values
 */
export function analyze({ traders, positions, markets, cfg }) {
  // ---- 1. Clean each trader's book and spot market makers ----
  const traderStats = traders.map((t) => {
    const raw = (positions.get(t.wallet) ?? []).filter((p) => positionValue(p) >= cfg.minPositionUsd);

    // Which outcomes does this trader hold in each market?
    const outcomesByMarket = new Map();
    for (const p of raw) {
      if (!outcomesByMarket.has(p.conditionId)) outcomesByMarket.set(p.conditionId, new Set());
      outcomesByMarket.get(p.conditionId).add(p.outcomeIndex ?? p.outcome);
    }
    const hedged = new Set([...outcomesByMarket].filter(([, s]) => s.size > 1).map(([id]) => id));
    const hedgeShare = outcomesByMarket.size ? hedged.size / outcomesByMarket.size : 0;
    const isMarketMaker = hedged.size >= cfg.marketMakerMinHedges && hedgeShare >= cfg.marketMakerHedgeShare;

    return {
      ...t,
      weight: traderWeight(t),
      hedgedMarkets: hedged.size,
      excludedReason: isMarketMaker ? 'market_maker' : raw.length === 0 ? 'no_positions' : null,
      openValue: raw.reduce((s, p) => s + positionValue(p), 0),
      positionsCount: raw.length,
      // Drop both sides of any market the trader is hedged in.
      book: raw.filter((p) => !hedged.has(p.conditionId)),
    };
  });

  // Everyone not flagged as a market maker counts toward the denominator,
  // including traders with no open positions (they "voted" for nothing).
  const eligible = traderStats.filter((t) => t.excludedReason !== 'market_maker');
  const totalWeight = eligible.reduce((s, t) => s + t.weight, 0) || 1;
  const eligibleCount = eligible.length || 1;

  // ---- 2. Group positions by market + outcome ----
  const groups = new Map();
  for (const t of eligible) {
    for (const p of t.book) {
      const key = `${p.conditionId}:${p.outcomeIndex ?? p.outcome}`;
      if (!groups.has(key)) groups.set(key, { key, sample: p, holders: [] });
      groups.get(key).holders.push({ trader: t, position: p });
    }
  }

  // Count traders on *other* outcomes of the same market (the opposition).
  const holdersByMarket = new Map();
  for (const g of groups.values()) {
    const id = g.sample.conditionId;
    holdersByMarket.set(id, (holdersByMarket.get(id) ?? 0) + g.holders.length);
  }

  // ---- 3. Score each group ----
  const bets = [];
  for (const g of groups.values()) {
    if (g.holders.length < cfg.minHoldersToStore) continue;
    const p0 = g.sample;
    const m = markets.get(p0.conditionId);
    // Only sports games happening today (see refresh.js, which tags each market).
    if (!m || !['upcoming', 'started'].includes(m.gameStatus)) continue;

    const sizeSum = g.holders.reduce((s, h) => s + h.position.size, 0);
    const avgEntry = sizeSum ? g.holders.reduce((s, h) => s + h.position.avgPrice * h.position.size, 0) / sizeSum : null;
    const invested = g.holders.reduce((s, h) => s + h.position.initialValue, 0);
    const currentValue = g.holders.reduce((s, h) => s + positionValue(h.position), 0);

    // Prefer Gamma's live price; fall back to the price on the position rows.
    const gammaIdx = m ? m.outcomes.findIndex((o) => String(o).toLowerCase() === String(p0.outcome).toLowerCase()) : -1;
    const curPrice = gammaIdx >= 0 && Number.isFinite(m.prices[gammaIdx]) ? m.prices[gammaIdx] : p0.curPrice;

    const flags = [];
    if (m.gameStatus === 'started') flags.push('started');
    if (m.closed || !m.acceptingOrders) flags.push('closed');
    if (curPrice !== null && curPrice > cfg.maxPrice) flags.push('price_above_max');
    if (curPrice !== null && curPrice < cfg.minPrice) flags.push('price_below_min');

    const holderWeight = g.holders.reduce((s, h) => s + h.trader.weight, 0);
    const weightedAgreement = holderWeight / totalWeight;

    bets.push({
      key: g.key,
      conditionId: p0.conditionId,
      outcome: p0.outcome,
      outcomeIndex: p0.outcomeIndex,
      title: m?.question || p0.title,
      slug: m?.slug ?? p0.slug,
      eventSlug: m?.eventSlug ?? p0.eventSlug,
      endDate: m.endDate ?? p0.endDate,
      gameStart: m.gameStartMs ? new Date(m.gameStartMs).toISOString() : null,
      league: m.league,
      sport: m.sport,
      marketType: m.sportsMarketType,
      holders: g.holders.length,
      opposingHolders: holdersByMarket.get(p0.conditionId) - g.holders.length,
      agreement: g.holders.length / eligibleCount,
      weightedAgreement,
      score: Math.round(weightedAgreement * 1000) / 10,
      invested,
      currentValue,
      avgEntry,
      curPrice,
      movement: avgEntry && curPrice !== null ? (curPrice - avgEntry) / avgEntry : null,
      flags,
      holderRows: g.holders.map(({ trader, position }) => ({
        wallet: trader.wallet,
        size: position.size,
        avgPrice: position.avgPrice,
        initialValue: position.initialValue,
        currentValue: positionValue(position),
        cashPnl: position.cashPnl,
      })),
    });
  }

  // Best first: highest score, then most money behind it.
  bets.sort((a, b) => b.score - a.score || b.invested - a.invested);

  return {
    bets,
    traders: traderStats.map(({ book, ...rest }) => rest),
    eligibleCount: eligible.length,
  };
}
