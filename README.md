# GleexhCoin UBIK Watcher

Autonomous, completely free companion to the GleexhCoin desk. Runs on GitHub Actions —
no computer needs to stay on, no Claude session needs to stay alive, no billing to manage.

## How it works

Every 5 minutes, GitHub Actions runs `watch.mjs`:

1. **Always:** fetches UBIK's price/MC/liquidity/volume from DexScreener's free public
   API and compares it to the last saved value in `state.json`.
2. **On a real trigger** — market cap moved ≥4% since the last check-in, crossed a key
   level, liquidity looks like it collapsed, or 10 minutes have passed since the last
   check-in — it builds a detailed message directly from the live data (price, MC,
   5m/1h/24h change, liquidity, volume, distance to the nearest support/resistance
   levels, an estimated position P&L) and posts it to your Discord webhook.
3. Otherwise it stays completely silent and just updates `state.json`.

No LLM call is involved — the alert is a template filled in from live numbers, not an
AI-generated report. That means no API key, no billing account, and nothing that can
ever run out of credits. The daily cap (`MAX_FULL_CYCLES_PER_DAY`, default 150) just
bounds how many Discord messages can fire in a day in the worst case — with a 10-minute
floor, a fully quiet market still posts roughly every 10-15 minutes as a status update.

## Historical data collection (`history.jsonl`)

**Every** run — not just alert-triggering ones — appends one line to `history.jsonl`:
timestamp, price, MC, liquidity, 24h volume, 5m/1h/24h % change, whether a level was
crossed, and a few raw signal flags (`approaching_<level>`, `broke_above_<level>`,
`momentum_up_all_timeframes`, etc. — see `detectSignals()` in `watch.mjs`). This is the
free, computer-independent dataset a real backtest needs: it accumulates automatically
on GitHub's infrastructure, no laptop or Claude session has to stay on.

**Honest caveat:** this only starts accumulating from whenever this file was first
committed — there's no way to get real historical minute-bar data for a coin that
young for free. The signal flags are raw and unvalidated (no lookahead, no fitted
thresholds) — they're inputs for backtesting later, not a strategy yet. Treat early
backtest results as low-confidence until there are enough bars (weeks, not hours) to
mean something. Scope is UBIK only for now; the same collection approach extends to
other coins later without changing the architecture.

## One-time setup

You need one repo secret (Settings → Secrets and variables → Actions → New repository
secret): **`DISCORD_WEBHOOK_URL`** — already set for you as part of this build.

That's it — the workflow (`.github/workflows/watch.yml`) is already scheduled and
working with no further setup.

## Tuning

Edit the constants at the top of `watch.mjs`:

- `MOVE_THRESHOLD_PCT` — how big a market cap move triggers an alert (default 4%)
- `FULL_CYCLE_FLOOR_MIN` — max minutes between forced check-ins even if nothing moves (default 10)
- `MAX_FULL_CYCLES_PER_DAY` — safety cap on alerts per day (default 150)

## Limits, honestly

- GitHub's free scheduler isn't exact below ~5 minutes and can be delayed during
  platform load — treat "every 5 min" as "close to every 5 min," not a guarantee.
- The estimated position P&L in each alert is computed from live price vs. cost basis
  and can differ slightly from the FOMO app's own displayed P&L (a known, minor
  discrepancy between how the two calculate it).
- This watcher does **not** write to the GleexhCoin dashboard artifact — that database
  is only reachable from inside a live Claude session. This is a separate, simpler
  channel (Discord) for when no Claude session is running.
- The alerts are templated from data, not AI-written analysis — no catalyst
  interpretation, no chart pattern read, no CEO-style synthesis. That level of judgment
  still comes from the full desk cycle when a Claude session is active.
- Not investment advice; it only reports and never executes trades.
