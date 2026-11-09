# Consensus Bets

A sportsbook-style dashboard of **today's sports games that Polymarket's best sports bettors agree on**. Each bet shows **real sportsbook odds** (best price across DraftKings, FanDuel, BetMGM and others). Pick the bets you like, enter how much you want to spend, and the **bet planner** tells you how much to put on each one: more on likely winners, less on risky ones.

- **Who counts as "best":** the 200 bettors with the highest *win rate above expected* on their recent resolved sports bets. They're picked from the top 500 on Polymarket's Sports leaderboard.
- **Which games:** any sport, but only games that start **today (New York time)** and haven't started yet.
- **Advice only.** It only *reads* public data. It never places bets, needs no wallet and never logs into a betting site.
- **Refresh rate:** every 10 minutes. Snapshots are kept in a small SQLite database, so you can see how consensus builds up before a game.

---

## How it works (the short version)

```
once a day   ─► Sports leaderboard (top 500 by profit)
               ─► each trader's last ~200 closed bets ─► sports only, 30+ bets
               ─► rank by edge (win rate − avg price paid) ─► keep best 200
every 10 min ─► those 200 traders' open positions
               ─► Gamma API: game start time, live price ─► keep games starting later today
               ─► The Odds API: best sportsbook price per bet (within a daily credit budget)
               ─► score + filter ─► save snapshot in SQLite
browser ─► Express server ─► reads latest snapshot ─► dashboard
```

| File | What it does |
|---|---|
| `src/config.js` | Every setting (pool size, thresholds, time zone, schedule). Each one can be overridden with an environment variable. |
| `src/http.js` | Rate-limited, caching, retrying HTTP client. Every API call goes through it. |
| `src/polymarket.js` | Sports leaderboard, positions, closed positions (Data API v2), market details (Gamma). |
| `src/pool.js` | Picks the 200 best sports bettors (daily). |
| `src/sports.js` | Detects sports markets and their sport; works out "today" in New York time. |
| `src/odds.js` | Sportsbook odds from The Odds API: budget, cache, and matching team names. |
| `public/planner.js` | The bet planner's math: splits your budget across your picks. |
| `src/analysis.js` | Grouping, filters, market-maker detection and scoring. A pure function with no network calls. |
| `src/db.js` | SQLite tables and queries. |
| `src/refresh.js` | The background job that ties it all together. |
| `src/server.js` | Web server, JSON API and the 10-minute scheduler. |
| `public/` | The dashboard (plain HTML/CSS/JS, no build step). |
| `test/` | Automated tests (run offline with fake API responses). |

### Picking the traders: "win rate above expected"

Raw win rate rewards the wrong people. Someone who only buys 95¢ favorites wins about 95% of the time while barely making money. So each trader gets:

- **Win rate:** the share of their recent resolved sports bets that made money.
- **Avg price paid:** roughly how often they *should* win. A 60¢ bet should win about 60% of the time.
- **Edge = win rate − avg price paid.** Winning 70% of 60¢ bets is +10 points; winning 90% of 95¢ bets is −5 points.

Traders need at least 30 resolved sports bets (`MIN_SPORTS_BETS`), so a lucky streak doesn't count. The 200 highest edges are kept (`TOP_TRADERS`), chosen from the top 500 on the Sports leaderboard (`POOL_SIZE`). Ranking takes a few minutes, so it's redone once a day (`POOL_MAX_AGE_HOURS`). To force it, run `npm run refresh -- --pool`.

### Scoring each bet

1. **Trader weight (0.5–1.0).** Grows with the trader's edge; +15 points or more earns full weight.
2. **Bet score (0–100).** The sum of the weights of traders holding the bet, divided by the sum of all selected traders' weights.
3. **Traders agreeing.** The raw number of selected traders holding the bet, for example "14 of 200". The dashboard slider filters on this (default: 2 or more).

### Filters

| Rule | Default | Setting |
|---|---|---|
| Not a sports game starting today (New York time) | not shown | `TIME_ZONE` |
| Game already started | hidden (tick the checkbox to see it) | |
| Outcome priced above 90¢ or below 5¢ | flagged and hidden | `MAX_PRICE`, `MIN_PRICE` |
| Trader holds both sides of a market | that market ignored for that trader | |
| Trader hedged in ≥3 markets and ≥20% of their markets | treated as a market maker and excluded entirely | `MM_MIN_HEDGES`, `MM_HEDGE_SHARE` |
| Positions under $50 | ignored as dust | `MIN_POSITION_USD` |

Use the **Sport** dropdown to show one sport, for example Basketball or Soccer.

### Sportsbook odds

Odds come from [The Odds API](https://the-odds-api.com). For each bet the app shows the **best decimal price** across US sportsbooks (for example `1.75 · FanDuel`). Polymarket's team names are matched to the sportsbooks' full names ("Celtics" → "Boston Celtics"), and the game start time must agree.

Only straight "who wins" bets (moneyline and soccer draws) have a sportsbook equivalent. Other bets, such as spreads, totals, or "Team X does *not* win", show odds converted from the Polymarket price instead, marked **PM** (58¢ → 1.72).

**Getting a key (free):**

1. Sign up at <https://the-odds-api.com> with the free plan, and copy the API key from the email.
2. In the project folder, open `.env` (copy `.env.example` if you don't have one) and set `ODDS_API_KEY=your-key`.
3. Restart the app.

**Budget:** the free plan has 500 credits a month, and each sport you fetch costs 1 credit. The app only fetches sports with bets today, refreshes each sport at most every hour (`ODDS_REFRESH_MINUTES`), spends at most 15 credits a day (`ODDS_DAILY_BUDGET`, about 450 a month), and stops when fewer than 10 are left. The status line shows how many credits are left. On a paid plan, raise `ODDS_DAILY_BUDGET` and lower `ODDS_REFRESH_MINUTES` for fresher odds.

### Bet planner

1. **Pick bets** by clicking their odds. Click again to remove one. Your picks are remembered in this browser.
2. **Enter your total budget** in the planner on the right, or tap $25 / $50 / $100 / $250 / $500.
3. **Choose how to split it:**
   - **Favor locks** (default): weight = win chance³ × consensus score. Most of the money goes on near-sure bets; a 75% bet gets about 4.6× the money of a 45% bet with the same score.
   - **Balanced:** weight = win chance × consensus score.
   - **Equal:** the same amount on each bet.
4. The planner shows each **stake**, its **share of the budget** and what it **pays if it wins**, plus the total if every bet wins, if every bet loses, and the **expected result** (the average outcome if the win chances are right). **Copy plan** copies it as text.

Stakes are whole dollars (or cents for small budgets) and always add up exactly to your budget. Each bet is tagged **Lock** (70%+ win chance), **Likely** (55–70%), **Toss-up** (45–55%) or **Risky** (under 45%). **VALUE** means the sportsbook odds pay more than Polymarket's win chance suggests.

Win chances come from Polymarket prices. Putting more on locks lowers your risk, but locks pay less, so it doesn't raise your expected profit. Games that have started drop out of the plan automatically.

---

## Run it locally (step by step)

### 1. Install Node.js 22 or newer

Download the **LTS** version from <https://nodejs.org>. Then open a terminal and check it:

```bash
node --version
```

You need `v22.13.0` or higher, because the app uses Node's built-in SQLite.

### 2. Install the app's dependencies

From the project folder:

```bash
npm install
```

This downloads two small libraries: `express` (web server) and `node-cron` (scheduler).

### 3. (Optional) Run the tests

```bash
npm test
```

You should see `# pass 14`. The tests use fake data, so they work offline.

### 4. Fetch data once

```bash
npm run refresh
```

You'll see a log of each step. **The first run takes about 5 minutes**, because it ranks 500 sports traders on their past bets (`ranking sports bettors (123/500)`). After that, each refresh takes about a minute, because the ranking is reused for 24 hours. Everything is saved to `data/consensus.db`.

Look for these lines:

- `pool: X of 500 had 30+ sports bets; kept 200`. If X is 0, Polymarket's closed-positions data isn't loading; send me the output.
- `gamma: … are games today`. If this is 0, the top bettors don't hold any of today's games yet. That's common in the morning, before lines firm up.

### 5. Start the dashboard

```bash
npm start
```

Open <http://localhost:3000>. The server also refreshes every 10 minutes on its own, as long as it's running. Stop it with `Ctrl + C`.

Tips:

- **Use `npm run dev` while editing code.** It restarts the server automatically when you save a file.
- **To refresh right now while the server is running**, use this command (it's allowed from your own machine without a token):

  ```bash
  curl -X POST http://localhost:3000/api/refresh
  ```
- **To change a setting**, copy `.env.example` to `.env` and edit it, then restart the server.

---

## Deploy (Railway)

**Why Railway and not Vercel?** This app needs two things: a disk that survives restarts (for the SQLite file) and a job every 10 minutes.

- **Railway** gives you an always-on server plus a persistent volume, and the app's built-in scheduler handles the 10-minute job. Railway has a free trial and a low-cost Hobby plan; check <https://railway.com/pricing> for current prices.
- **Vercel** functions have no persistent disk. Its free plan's cron jobs run at most once a day, so it would need an external database and a paid plan to refresh every 10 minutes.

### Steps

1. **Put the code on GitHub.** Create an empty repository on GitHub, then run these from the project folder:

   ```bash
   git add .
   ```

   ```bash
   git commit -m "Consensus bets dashboard"
   ```

   ```bash
   git remote add origin https://github.com/<you>/consensus-bets.git
   ```

   ```bash
   git push -u origin main
   ```
2. **Create the Railway service.** Go to <https://railway.com>, choose **New Project → Deploy from GitHub repo**, and pick your repo. Railway detects Node.js, runs `npm install`, then runs `npm start` (configured in `railway.json`).
3. **Add a volume**, so the database survives redeploys. Right-click the service → **Attach Volume** → mount path `/data`.
4. **Set the variables** in the service's **Variables** tab:
   - `DB_PATH` = `/data/consensus.db`
   - `APP_PASSWORD` = a password of your choice. **Set this online**: it keeps strangers out, and the Refresh button only works for people who entered it. The browser will ask for it; any username works.
   - `ODDS_API_KEY` = your key from the-odds-api.com
   - `REFRESH_TOKEN` = any long random string (optional; this lets you trigger refreshes remotely)
5. **Get a URL.** Go to **Settings → Networking → Generate Domain**.
6. **Check it works.** Open the URL. The first refresh starts automatically when the server boots. Because it ranks the traders first, the dashboard fills in after about 5 minutes. Logs are in the **Deployments** tab.

To trigger a refresh remotely (for example from a free external cron service like cron-job.org, as a backup):

```bash
curl -X POST https://<your-app>.up.railway.app/api/refresh -H "Authorization: Bearer <REFRESH_TOKEN>"
```

**Run only one instance (replica).** The scheduler runs inside the server, so two instances would refresh twice.

---

## API rate limits & caching

- **Rate limiting.** Requests are spaced to at most 8 per second for Polymarket's Data API and 5 per second for Gamma (`PM_DATA_RPS`, `PM_GAMMA_RPS`). That's well under Polymarket's published limit of 150 requests per 10 s for `/positions`.
- **Retries.** HTTP 429 and 5xx responses are retried with exponential backoff, and the server's `Retry-After` header is honored.
- **Batching and caching.** Trader rankings (the expensive part) are computed once a day. Gamma is only asked about markets that could be today's games, 25 per request. Sportsbook odds are cached in the database per sport (see the budget above).
- **No overlapping runs.** If a refresh is still running when the next one is due, the new one is skipped.

## Database size

144 snapshots per day (one every 10 minutes), each holding only today's games with 2 or more holders. Per-trader holder rows are kept for 3 days, and bet-level history for 30 days (`RETENTION_DAYS`). Expect tens of MB. If you still have a database from the older version of the app, it's reset automatically on first start.

## API notes (verified Oct 29, 2026)

- **Polymarket retired Data API v1 on Oct 24, 2026.** This app uses v2 (`/v2/leaderboard`, `/v2/positions`, `/v2/closed-positions`). v2 uses snake_case fields and returns `{ data, pagination }` with cursor paging. The code also accepts the old v1 field names, as a safety net.
- **v2 leaderboard parameter names.** Sources disagree on casing (`timePeriod` vs `time_period`). The client tries both, with `category=SPORTS`.
- **Closed positions order.** By default they come back sorted by profit, biggest first, which would inflate win rates. The client asks for newest-first and checks that the order really is by date before using a sorting option.
- **Game start times** come from Gamma's `gameStartTime` field on sports markets.
- **Closed bets** come from `/v2/positions?status=CLOSED`; v2 has no `/closed-positions` endpoint (it returns 404).
- **The Odds API key** is never shown in logs or on the dashboard; error messages replace it with `***`.

If something breaks after an API change, the refresh logs (and the red dot next to "Last updated") show the failing URL and HTTP status.

*Not financial advice. Top traders' open positions can be hedges against bets placed elsewhere, so a consensus here is not a prediction.*
