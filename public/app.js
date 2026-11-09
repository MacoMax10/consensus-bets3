// Dashboard logic. Talks only to our own server's /api endpoints.
// Sections: helpers -> loading -> event list -> bet planner -> detail drawer ->
// chart -> wiring.

import { planStakes, riskLabel, STRATEGIES } from './planner.js';

const $ = (sel) => document.querySelector(sel);
const saved = loadPlan();
const state = {
  bets: [], snapshot: null, status: null,
  sport: '',
  picks: saved.picks,              // keys of the bets you picked
  budget: saved.budget,            // total you're willing to spend (text, as typed)
  strategy: saved.strategy,        // 'locks' | 'balanced' | 'equal'
};

// ---------- Formatting helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cents = (p) => (p === null || p === undefined ? '—' : `${(p * 100).toFixed(1)}¢`);
const pct = (x, digits = 0) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(digits)}%`);
const signedPct = (x) => (x === null || x === undefined ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`);
const signedPts = (x) => (x === null || x === undefined ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)} pts`);
const money = (x) => (x === null || x === undefined ? '—' : `$${Number(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const usdShort = (x) => {
  if (x === null || x === undefined) return '—';
  const a = Math.abs(x);
  const s = a >= 1e6 ? `$${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `$${(a / 1e3).toFixed(1)}k` : `$${a.toFixed(0)}`;
  return x < 0 ? `-${s}` : s;
};
const odds2 = (o) => (o ? Number(o).toFixed(2) : '—');
const ago = (iso) => {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const shortWallet = (w) => `${w.slice(0, 6)}…${w.slice(-4)}`;
const tz = () => state.status?.settings.timeZone ?? 'America/New_York';
const kickoff = (d) => (d ? new Date(d).toLocaleTimeString('en-US', { timeZone: tz(), hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : '—');
const hasStarted = (b) => b.flags.includes('started') || (b.game_start && Date.parse(b.game_start) <= Date.now());
const FLAG_TEXT = { closed: 'Closed', price_above_max: 'Price > 90¢', price_below_min: 'Price < 5¢', started: 'Started' };
const betByKey = (key) => state.bets.find((b) => b.key === key);

/** The odds shown for a bet: best sportsbook price, else Polymarket-implied. */
const oddsOf = (b) => (b?.odds_price ? { odds: b.odds_price, source: b.odds_book } : b?.pm_odds ? { odds: b.pm_odds, source: 'PM' } : null);

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error ?? `${res.status} ${res.statusText}`);
    Object.assign(err, { status: res.status, code: body.code, details: body.details });
    throw err;
  }
  return body;
}
const post = (path, data = {}) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast${isError ? ' err' : ''}`;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 3500);
}

// Your picks, budget and strategy survive a page reload (stored in this browser only).
function loadPlan() {
  const fallback = { picks: [], budget: '100', strategy: 'locks' };
  try { return { ...fallback, ...JSON.parse(localStorage.getItem('cb-plan') || '{}') }; } catch { return fallback; }
}
function savePlan() {
  try { localStorage.setItem('cb-plan', JSON.stringify({ picks: state.picks, budget: state.budget, strategy: state.strategy })); } catch { /* storage unavailable */ }
}

// ---------- Loading ----------
async function load() {
  const [status, data] = await Promise.all([api('/api/status'), api('/api/bets')]);
  state.status = status;
  state.snapshot = data.snapshot;
  state.bets = data.bets;
  renderAll();
}

function renderAll() {
  renderHeader();
  renderStatus();
  renderPills();
  renderEvents();
  // Don't redraw the planner under someone typing their budget.
  const typing = document.activeElement?.tagName === 'INPUT' && $('#slipBody').contains(document.activeElement);
  if (!typing) renderPlanner();
}

function renderHeader() {
  $('#slipCount').textContent = state.picks.length;
  const running = state.status?.refresh.running;
  $('#refreshBtn').disabled = running;
  $('#refreshBtn').textContent = running ? 'Refreshing…' : '↻ Refresh';
}

function renderStatus() {
  const { refresh, periods, pool, odds } = state.status;
  const p = Object.values(periods)[0];
  const el = $('#updated');
  const oddsNote = odds.enabled
    ? ` · sportsbook odds: ${odds.remaining ?? '?'} credits left this month`
    : ' · no ODDS_API_KEY: showing Polymarket odds';
  if (refresh.running) {
    el.innerHTML = `<span class="dot busy"></span>Refreshing: ${esc(refresh.step ?? '')}…`;
  } else if (p.latest) {
    const failed = p.lastAttempt && p.lastAttempt.status === 'error' && p.lastAttempt.id > p.latest.id;
    el.innerHTML = `<span class="dot ${failed ? 'err' : ''}"></span>Updated ${esc(ago(p.latest.created_at))}` +
      `${pool.builtAt ? ` · top bettors ranked ${esc(ago(pool.builtAt))}` : ''}${esc(oddsNote)}` +
      (failed ? ` · last refresh failed: ${esc(p.lastAttempt.error)}` : '');
  } else if (p.lastAttempt?.status === 'error') {
    el.innerHTML = `<span class="dot err"></span>Refresh failed: ${esc(p.lastAttempt.error)}`;
  } else {
    el.textContent = 'No data yet: the first refresh is running (about 5 minutes the first time).';
  }
}

// ---------- Event list ----------
function visibleBets({ ignoreSport = false } = {}) {
  const min = Number($('#agree').value);
  const showFlagged = $('#showFlagged').checked;
  const booksOnly = $('#booksOnly').checked;
  const q = $('#search').value.trim().toLowerCase();
  return state.bets.filter((b) =>
    b.holders >= min &&
    (showFlagged || (b.flags.length === 0 && !hasStarted(b))) &&
    (ignoreSport || !state.sport || b.sport === state.sport) &&
    (!booksOnly || b.odds_price) &&
    (!q || `${b.title} ${b.outcome}`.toLowerCase().includes(q)));
}

function renderPills() {
  const counts = new Map();
  for (const b of visibleBets({ ignoreSport: true })) if (b.sport) counts.set(b.sport, (counts.get(b.sport) ?? 0) + 1);
  if (state.sport && !counts.has(state.sport)) counts.set(state.sport, 0);
  const all = [...counts.values()].reduce((a, b) => a + b, 0);
  $('#sportPills').innerHTML = [['', 'All sports', all], ...[...counts].sort((a, b) => b[1] - a[1]).map(([s, n]) => [s, s, n])]
    .map(([value, label, n]) => `<button type="button" data-sport="${esc(value)}" aria-pressed="${state.sport === value}">${esc(label)}<span class="n">${n}</span></button>`)
    .join('');
}

function renderEvents() {
  const bets = visibleBets();
  const snap = state.snapshot;
  const eligible = snap?.eligible_count ?? 0;
  if (eligible) $('#agree').max = Math.max(2, eligible);
  const withBooks = bets.filter((b) => b.odds_price).length;
  $('#summary').innerHTML = snap
    ? `<span><strong>${bets.length}</strong> bets</span><span><strong>${eligible}</strong> top bettors tracked</span>` +
      `<span><strong>${usdShort(bets.reduce((s, b) => s + b.invested, 0))}</strong> behind them</span>` +
      `<span><strong>${withBooks}/${bets.length}</strong> with sportsbook odds</span>`
    : '';

  const inSlip = new Set(state.picks);
  $('#events').innerHTML = bets.map((b) => {
    const o = oddsOf(b);
    const started = hasStarted(b);
    const moveCls = b.movement > 0 ? 'up' : b.movement < 0 ? 'down' : '';
    return `<article class="event${b.flags.length || started ? ' flagged' : ''}" tabindex="0" data-key="${esc(b.key)}">
      <div>
        <div class="event-meta">
          <span class="time">${esc(kickoff(b.game_start))}</span>
          <span>${esc(b.sport ?? '')}${b.league ? ` · ${esc(b.league.toUpperCase())}` : ''}</span>
          ${b.flags.map((f) => `<span class="flag">${esc(FLAG_TEXT[f] ?? f)}</span>`).join('')}
        </div>
        <div class="event-title">${esc(b.title)}</div>
        <div class="consensus">
          <span><b>${b.holders}/${eligible}</b> top bettors <span class="bar"><i style="width:${Math.min(100, b.agreement * 100 * 3)}%"></i></span></span>
          <span>Score <b>${b.score.toFixed(1)}</b></span>
          <span><b>${usdShort(b.invested)}</b> in</span>
          <span>${cents(b.avg_entry)} → ${cents(b.cur_price)} <span class="${moveCls}">${signedPct(b.movement)}</span></span>
        </div>
      </div>
      <button class="odds-btn${inSlip.has(b.key) ? ' selected' : ''}" type="button" data-pick="${esc(b.key)}" ${!o || started ? 'disabled' : ''}
        aria-pressed="${inSlip.has(b.key)}" title="${o ? esc(o.source === 'PM' ? 'Converted from the Polymarket price' : `Best price: ${o.source}`) : 'No odds'}">
        <span class="pick">${esc(b.outcome)}</span>
        <span class="price">${o ? odds2(o.odds) : '—'}</span>
        <span class="book">${o ? esc(o.source) : 'no odds'}</span>
      </button>
    </article>`;
  }).join('');

  const empty = $('#empty');
  empty.hidden = bets.length > 0;
  if (!bets.length) {
    empty.innerHTML = snap
      ? `No upcoming games right now are backed by ${esc($('#agree').value)} or more top bettors${state.sport ? ` in ${esc(state.sport)}` : ''}. Late in the evening most of today's games have already started.`
      : 'No data yet. The first refresh is running, or press ↻ Refresh.';
  }
}

// ---------- Bet planner ----------
const stakeNum = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
const isDead = (b) => !b || hasStarted(b) || b.flags.includes('closed');

/** What the planner needs for one pick: win chance, odds and consensus score. */
function pickInfo(key) {
  const b = betByKey(key);
  const o = oddsOf(b);
  if (!b || !o) return null;
  return { key, bet: b, odds: o.odds, source: o.source, p: b.cur_price ?? 1 / o.odds, score: b.score };
}

function togglePick(key) {
  const i = state.picks.indexOf(key);
  if (i >= 0) state.picks.splice(i, 1);
  else if (oddsOf(betByKey(key))) state.picks.push(key);
  savePlan();
  renderAll();
  if (window.matchMedia('(max-width: 1000px)').matches && i < 0) toast('Added to planner');
}

function renderPlanner() {
  const body = $('#slipBody');
  if (!state.picks.length) {
    body.innerHTML = `<div class="slip-empty"><span class="icon">🎯</span>Pick the bets you like by clicking their odds.<br>
      Then enter how much you want to spend, and the planner splits it for you.</div>`;
    return;
  }
  const live = state.picks.map(pickInfo).filter((x) => x && !isDead(x.bet));
  const dead = state.picks.filter((k) => !live.some((x) => x.key === k));
  const plan = planStakes(live, stakeNum(state.budget), state.strategy);
  const sign = (x) => `${x >= 0 ? '+' : '−'}${money(Math.abs(x))}`;

  body.innerHTML = `
    <div class="budget">
      <label for="budget">How much do you want to spend in total?</label>
      <div class="money-input"><span>$</span><input id="budget" type="number" min="0" step="1" inputmode="decimal" placeholder="100" value="${esc(state.budget)}"/></div>
      <div class="chips">${[25, 50, 100, 250, 500].map((v) => `<button type="button" data-budget="${v}">$${v}</button>`).join('')}</div>
    </div>
    <div class="seg" role="group" aria-label="How to split">
      ${Object.entries(STRATEGIES).map(([k, s]) => `<button type="button" data-strategy="${k}" aria-pressed="${state.strategy === k}">${esc(s.label)}</button>`).join('')}
    </div>
    <div class="slip-scroll">
      <button class="clear-all" type="button" id="clearSlip">Clear all</button>
      ${plan.rows.map((r) => {
        const risk = riskLabel(r.p);
        const value = r.p * r.odds > 1.02;
        return `<div class="plan-row">
          <div>
            <div class="leg-pick"><span>${esc(r.bet.outcome)}</span><span class="risk ${risk.toLowerCase()}">${risk}</span>
              ${value ? '<span class="value-tag" title="These odds pay more than the win chance suggests">VALUE</span>' : ''}</div>
            <div class="leg-title">${esc(r.bet.title)} · ${esc(kickoff(r.bet.game_start))}</div>
          </div>
          <div class="stake"><b>${money(r.stake)}</b><span>${Math.round(r.share * 100)}% of budget</span></div>
          <div class="facts">
            <span><b>${Math.round(r.p * 100)}%</b> win chance · <b>${odds2(r.odds)}</b> ${esc(r.source === 'PM' ? 'Polymarket' : r.source)}</span>
            <span>Wins <b>${money(r.payout)}</b></span>
          </div>
          <button class="leg-remove row-remove" type="button" data-remove="${esc(r.key)}" aria-label="Remove">×</button>
        </div>`;
      }).join('')}
      ${dead.map((k) => `<div class="plan-row dead"><div><div class="leg-pick">${esc(betByKey(k)?.outcome ?? 'Unavailable')}</div>
        <div class="leg-title">${esc(betByKey(k)?.title ?? 'No longer listed')}: game started or closed, so it's left out of the plan</div></div>
        <button class="leg-remove row-remove" type="button" data-remove="${esc(k)}" aria-label="Remove">×</button></div>`).join('')}
    </div>
    <div class="slip-foot">
      ${live.length && plan.total ? `
      <div class="summary-box">
        <div><div class="label">Total to place</div><div class="value">${money(plan.total)}</div></div>
        <div><div class="label">If every bet wins</div><div class="value up">${sign(plan.ifAllWin)}</div></div>
        <div><div class="label" title="Average result over many days if the win chances are right">Expected result</div><div class="value ${plan.expectedProfit >= 0 ? 'up' : 'down'}">${sign(plan.expectedProfit)}</div></div>
        <div><div class="label">If every bet loses</div><div class="value down">−${money(plan.total)}</div></div>
      </div>
      <details class="plan-note"><summary>How is this split?</summary>${esc(state.strategy === 'equal' ? 'Same amount on every bet.' : state.strategy === 'balanced'
        ? 'More on bets that are likely to win and that the top bettors agree on most.'
        : 'Most of the money goes on the safest bets (locks), little on risky ones.')}
        Locks pay less when they win, so this lowers your risk rather than raising your profit. "Expected result" is the average outcome if the win chances are right; they come from Polymarket prices and can be wrong.</details>
      <div class="plan-actions"><button class="btn-green" type="button" id="copyPlan">Copy plan</button></div>`
      : `<p class="plan-note">${live.length ? 'Enter how much you want to spend.' : 'None of your picks can still be bet on.'}</p>`}
    </div>`;
  state.lastPlan = plan;
}

/** The plan as plain text, ready to paste into notes or a message. */
function planText(plan) {
  const lines = plan.rows.map((r) => `${money(r.stake)} on ${r.bet.outcome} (${r.bet.title}) @ ${odds2(r.odds)} ${r.source === 'PM' ? 'Polymarket' : r.source} -> wins ${money(r.payout)}`);
  return [`Bet plan: ${money(plan.total)} total (${STRATEGIES[state.strategy].label})`, ...lines,
    `If every bet wins: +${money(plan.ifAllWin)}`].join('\n');
}

// ---------- Detail drawer ----------
async function openBet(key) {
  const { bet, history } = await api(`/api/bet?key=${encodeURIComponent(key)}`);
  const eligible = state.snapshot.eligible_count;
  const o = oddsOf(bet);

  $('#detail').innerHTML = `
    <h2>${esc(bet.title)}</h2>
    <div class="event-meta"><span class="time">${esc(kickoff(bet.game_start))}</span><span>${esc(bet.sport ?? '')}${bet.league ? ` · ${esc(bet.league.toUpperCase())}` : ''}</span>
      ${bet.flags.map((f) => `<span class="flag">${esc(FLAG_TEXT[f] ?? f)}</span>`).join('')}</div>
    <div class="kv">
      ${kv('Pick', bet.outcome)}
      ${kv('Odds', o ? `${odds2(o.odds)} · ${o.source === 'PM' ? 'Polymarket' : o.source}` : '—')}
      ${kv('Top bettors agreeing', `${bet.holders}/${eligible} (${pct(bet.agreement)})`)}
      ${kv('On the other side', bet.opposing_holders)}
      ${kv('Weighted score', bet.score.toFixed(1))}
      ${kv('$ invested', usdShort(bet.invested))}
      ${kv('Avg entry → now', `${cents(bet.avg_entry)} → ${cents(bet.cur_price)}`)}
      ${kv('Move since entry', signedPct(bet.movement))}
    </div>
    <p class="small">${bet.polymarket_url ? `<a href="${esc(bet.polymarket_url)}" target="_blank" rel="noopener">Open on Polymarket ↗</a>` : ''}</p>

    <h3>Top bettors agreeing over time</h3>
    <div id="chartAgree"></div>
    <h3>Win chance over time</h3>
    <div class="legend"><span><i style="background:var(--series-pm)"></i>Polymarket price</span><span><i style="background:var(--series-book)"></i>Sportsbook (1 ÷ odds)</span></div>
    <div id="chartPrice"></div>
    <details><summary>Show history as a table</summary>
      <div class="table-wrap"><table><thead><tr><th>Snapshot</th><th class="num">Bettors</th><th class="num">Polymarket</th><th class="num">Sportsbook odds</th></tr></thead>
      <tbody>${history.slice().reverse().map((h) => `<tr><td>${esc(new Date(h.created_at).toLocaleString())}</td>
        <td class="num">${h.holders ?? 0}</td><td class="num">${cents(h.cur_price)}</td><td class="num">${odds2(h.odds_price)}</td></tr>`).join('')}</tbody></table></div>
    </details>

    <h3>Top bettors holding this (${bet.holderList.length})</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Rank</th><th>Bettor</th><th class="num">Sports bets</th><th class="num">Win rate</th><th class="num">Avg price paid</th>
        <th class="num">Edge</th><th class="num">Weight</th><th class="num">Position</th><th class="num">Entry</th></tr></thead>
      <tbody>${bet.holderList.map((h) => `<tr>
        <td>${h.rank ?? '—'}</td>
        <td><a href="https://polymarket.com/profile/${esc(h.wallet)}" target="_blank" rel="noopener">${esc(h.name || shortWallet(h.wallet))}</a></td>
        <td class="num">${h.sports_bets ?? '—'}</td>
        <td class="num">${pct(h.win_rate)}</td>
        <td class="num">${cents(h.trader_avg_entry)}</td>
        <td class="num ${h.edge > 0 ? 'up' : h.edge < 0 ? 'down' : ''}">${signedPts(h.edge)}</td>
        <td class="num">${h.weight.toFixed(2)}</td>
        <td class="num">${usdShort(h.initial_value)}</td>
        <td class="num">${cents(h.avg_price)}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    <p class="small muted">Edge = win rate − average price paid: how much better a bettor does than the odds. Weight (0.5–1.0) grows with edge and sets how much their vote counts in the score.</p>`;

  const points = history.map((h) => ({ t: new Date(h.created_at).getTime(), ...h }));
  lineChart($('#chartAgree'), [{ name: 'Top bettors', color: 'var(--series-pm)', values: points.map((p) => ({ t: p.t, v: p.holders ?? 0 })) }],
    { yMin: 0, yMax: Math.max(4, ...points.map((p) => p.holders ?? 0)), fmt: (v) => String(Math.round(v * 10) / 10) });
  lineChart($('#chartPrice'), [
    { name: 'Polymarket', color: 'var(--series-pm)', values: points.filter((p) => p.cur_price !== null).map((p) => ({ t: p.t, v: p.cur_price })) },
    { name: 'Sportsbook', color: 'var(--series-book)', values: points.filter((p) => p.odds_price).map((p) => ({ t: p.t, v: 1 / p.odds_price })) },
  ], { yMin: 0, yMax: 1, fmt: cents });

  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#scrim').hidden = false;
}
const kv = (label, value) => `<div><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div></div>`;

function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#scrim').hidden = true;
}

// ---------- A tiny SVG line chart with a hover crosshair ----------
const axisTime = (t, span) => (span < 86_400_000
  ? new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  : new Date(t).toLocaleDateString());
function lineChart(el, series, { yMin, yMax, fmt }) {
  series = series.filter((s) => s.values.length);
  const all = series.flatMap((s) => s.values);
  if (all.length < 2) {
    el.innerHTML = '<p class="small muted">The chart appears once there are at least two snapshots (about 20 minutes of refreshes).</p>';
    return;
  }
  const W = 700, H = 180, L = 44, R = 12, T = 10, B = 24;
  const t0 = Math.min(...all.map((p) => p.t)), t1 = Math.max(...all.map((p) => p.t));
  const x = (t) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - T - B);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => yMin + f * (yMax - yMin));

  el.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.name).join(' and '))} over time">
    ${ticks.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${esc(fmt(v))}</text>`).join('')}
    <text class="axis" x="${L}" y="${H - 6}">${esc(axisTime(t0, t1 - t0))}</text>
    <text class="axis" x="${W - R}" y="${H - 6}" text-anchor="end">${esc(axisTime(t1, t1 - t0))}</text>
    ${series.map((s) => `<polyline fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"
        vector-effect="non-scaling-stroke" points="${s.values.map((p) => `${x(p.t)},${y(p.v)}`).join(' ')}"/>`).join('')}
    <line class="crosshair" y1="${T}" y2="${H - B}" visibility="hidden"/>
    <rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>
  </svg>`;

  const svg = el.querySelector('svg');
  const cross = svg.querySelector('.crosshair');
  const tip = $('#tooltip');
  const times = [...new Set(all.map((p) => p.t))].sort((a, b) => a - b);
  svg.addEventListener('mousemove', (e) => {
    const box = svg.getBoundingClientRect();
    const tx = t0 + ((e.clientX - box.left) / box.width * W - L) / (W - L - R) * (t1 - t0);
    const t = times.reduce((best, c) => (Math.abs(c - tx) < Math.abs(best - tx) ? c : best), times[0]);
    cross.setAttribute('x1', x(t)); cross.setAttribute('x2', x(t)); cross.setAttribute('visibility', 'visible');
    tip.innerHTML = `<div class="muted">${esc(new Date(t).toLocaleString())}</div>` + series.map((s) => {
      const p = s.values.find((v) => v.t === t);
      return `<div><i style="display:inline-block;width:10px;height:2px;background:${s.color};vertical-align:middle;margin-right:6px"></i>${esc(s.name)}: <strong>${p ? esc(fmt(p.v)) : '—'}</strong></div>`;
    }).join('');
    tip.hidden = false;
    tip.style.left = `${Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8)}px`;
    tip.style.top = `${e.clientY + 14}px`;
  });
  svg.addEventListener('mouseleave', () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; });
}

// ---------- Wiring ----------
function savePrefs() {
  try { localStorage.setItem('cb-prefs-v3', JSON.stringify({ minTraders: $('#agree').value, sport: state.sport })); } catch { /* storage unavailable */ }
}
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('cb-prefs-v3') || '{}');
    if (p.minTraders) $('#agree').value = p.minTraders;
    if (p.sport) state.sport = p.sport;
    return Boolean(p.minTraders);
  } catch { return false; }
}
const showError = (err) => { $('#updated').innerHTML = `<span class="dot err"></span>${esc(err.message)}`; };
const rerenderList = () => { renderPills(); renderEvents(); };

$('#agree').addEventListener('input', () => { $('#agreeVal').textContent = $('#agree').value; savePrefs(); rerenderList(); });
['#showFlagged', '#booksOnly'].forEach((s) => $(s).addEventListener('change', rerenderList));
$('#search').addEventListener('input', rerenderList);
$('#sportPills').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-sport]');
  if (!btn) return;
  state.sport = btn.dataset.sport;
  savePrefs();
  rerenderList();
});

$('#events').addEventListener('click', (e) => {
  const pick = e.target.closest('[data-pick]');
  if (pick) return togglePick(pick.dataset.pick);
  const row = e.target.closest('.event');
  if (row && !e.target.closest('a')) openBet(row.dataset.key).catch(showError);
});
$('#events').addEventListener('keydown', (e) => {
  const row = e.target.closest('.event');
  if (row && e.key === 'Enter' && e.target === row) openBet(row.dataset.key).catch(showError);
});

// Planner: budget, strategy, remove, copy
$('#slipBody').addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.strategy) { state.strategy = t.dataset.strategy; savePlan(); renderPlanner(); }
  else if (t.dataset.budget) { state.budget = t.dataset.budget; savePlan(); renderPlanner(); }
  else if (t.dataset.remove) togglePick(t.dataset.remove);
  else if (t.id === 'clearSlip') { state.picks = []; savePlan(); renderAll(); }
  else if (t.id === 'copyPlan' && state.lastPlan) {
    try { await navigator.clipboard.writeText(planText(state.lastPlan)); toast('Plan copied'); } catch { toast('Could not copy. Select the text instead.', true); }
  }
});
// Typing the budget: re-draw the plan, then put the cursor back in the box.
$('#slipBody').addEventListener('input', (e) => {
  if (e.target.id !== 'budget') return;
  state.budget = e.target.value;
  savePlan();
  renderPlanner();
  const again = $('#budget');
  again.focus();
  try { again.setSelectionRange(again.value.length, again.value.length); } catch { /* number inputs don't support selection */ }
});

// Small screens: the planner slides in from the right.
$('#slipToggle').addEventListener('click', () => $('#slip').classList.add('open'));
$('#slipClose').addEventListener('click', () => $('#slip').classList.remove('open'));

// Refresh: ask the server for fresh data, then follow its progress every 3 seconds.
$('#refreshBtn').addEventListener('click', async () => {
  $('#refreshBtn').disabled = true;
  try {
    await post('/api/refresh');
  } catch (err) {
    if (err.status !== 409) { toast(err.message, true); $('#refreshBtn').disabled = false; return; }
  }
  await load().catch(showError);
  const poll = setInterval(async () => {
    try {
      await load();
      if (!state.status.refresh.running) clearInterval(poll);
    } catch (err) { clearInterval(poll); showError(err); }
  }, 3000);
});

$('#closeDrawer').addEventListener('click', closeDrawer);
$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeDrawer();
  $('#slip').classList.remove('open');
});

async function boot() {
  const hasPrefs = loadPrefs();
  if (!hasPrefs) {
    try { const s = await api('/api/status'); $('#agree').value = s.settings.defaultMinTraders; } catch { /* ignore */ }
  }
  $('#agreeVal').textContent = $('#agree').value;
  await load();
  // Keep balance, bets and "Updated …" current.
  setInterval(() => load().catch(showError), 60_000);
}
boot().catch(showError);
