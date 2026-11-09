// Bet planner math: split a budget across the bets you picked.
// Pure functions (no page, no network), shared by the dashboard and the tests.
//
// Each pick has:
//   p      win chance, 0..1 (the Polymarket price: 62¢ ≈ 62% chance)
//   odds   decimal odds you'd get (sportsbook, or converted from Polymarket)
//   score  consensus score, 0..100 (how strongly the top bettors agree)
//
// A strategy turns those into a weight; each bet gets budget × its share of
// the total weight. "Favor locks" cubes the win chance, so near-sure bets get
// much more than coin flips.

export const STRATEGIES = {
  locks: { label: 'Favor locks', weight: (p, s) => p ** 3 * s },
  balanced: { label: 'Balanced', weight: (p, s) => p * s },
  equal: { label: 'Equal', weight: () => 1 },
};

/** Plain-English risk level from the win chance. */
export function riskLabel(p) {
  if (p >= 0.7) return 'Lock';
  if (p >= 0.55) return 'Likely';
  if (p >= 0.45) return 'Toss-up';
  return 'Risky';
}

/**
 * Split `budget` across `picks`. Stakes are whole dollars when the budget
 * allows ($5+ per bet), otherwise cents, and always add up to the budget
 * exactly (largest-remainder rounding).
 */
export function planStakes(picks, budget, strategy = 'locks') {
  const B = Number(budget);
  const weightFn = (STRATEGIES[strategy] ?? STRATEGIES.locks).weight;
  if (!picks.length || !Number.isFinite(B) || B <= 0) {
    return { rows: picks.map((p) => ({ ...p, stake: 0, share: 0, payout: 0 })), total: 0, ifAllWin: 0, expectedProfit: 0 };
  }

  const weights = picks.map((p) => Math.max(weightFn(clamp01(p.p), Math.max(Number(p.score) || 0, 0.5)), 1e-9));
  const W = weights.reduce((a, b) => a + b, 0);

  // Work in whole units (dollars or cents) so the total is exact.
  const unit = B >= 5 * picks.length ? 1 : 0.01;
  const units = Math.round(B / unit);
  const raw = weights.map((w) => (units * w) / W);
  const base = raw.map(Math.floor);
  let left = units - base.reduce((a, b) => a + b, 0);
  raw.map((r, i) => [r - base[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => {
    if (left > 0) { base[i] += 1; left -= 1; }
  });

  const rows = picks.map((p, i) => {
    const stake = round2(base[i] * unit);
    return { ...p, stake, share: stake / B, payout: round2(stake * p.odds) };
  });
  const total = round2(rows.reduce((s, r) => s + r.stake, 0));
  return {
    rows,
    total,
    ifAllWin: round2(rows.reduce((s, r) => s + r.payout, 0) - total),
    // Average result if the win chances are right: sum of stake × (chance × odds) − total.
    expectedProfit: round2(rows.reduce((s, r) => s + r.stake * clamp01(r.p) * r.odds, 0) - total),
  };
}

const clamp01 = (x) => Math.min(1, Math.max(0, Number(x) || 0));
const round2 = (x) => Math.round(x * 100) / 100;
