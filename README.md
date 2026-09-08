# GleexhCoin UBIK Watcher

Autonomous, completely free companion to the GleexhCoin desk. Runs on GitHub Actions —
no computer needs to stay on, no Claude session needs to stay alive, no billing to manage.

## How it works — fast-loop mode

`watch.mjs` is a long-lived loop, not a one-shot script. GitHub Actions restarts it
roughly hourly (`.github/workflows/watch.yml`, offset to `:07` to dodge GitHub's own
top-of-hour congestion) and each run polls continuously for up to ~55 minutes before
exiting cleanly so the next scheduled run can pick up — this works around GitHub's
~6-hour single-job runtime cap while staying effectively continuous. Public repos get
free/unlimited GitHub Actions minutes, so this costs nothing.

Every ~15 seconds:

1. **Always:** fetches UBIK's price/MC/liquidity/volume from DexScreener's free public
   API and appends a row to `history.jsonl`.
2. **On a real trigger** — market cap moved ≥4% since the *last alert* (not the last
   poll — see below), a "flash move" of ≥2.5% within any 60-second window, crossed a key
   level, or liquidity looks like it collapsed — it posts a Discord alert immediately,
   within seconds of the move, not minutes. A 60-minute heartbeat still fires if nothing
   happens, mostly as a liveness check.
3. Otherwise it stays completely silent and just updates in-memory state.

State and history are flushed to git every ~2 minutes (not every poll, to avoid
hammering git with a commit every 15s), plus a final flush when a run exits.

**Why the redesign:** the old design polled once per 5-10 minute cron tick, so both the
reported price and the alert could lag the real market by many minutes — exactly what
made Discord alerts feel late and the reported price feel off from what FOMO showed live.
Polling every 15s inside one continuously-running job closes that gap to seconds, and
comparing moves against the *last alert's* price (not the previous poll) means a slow
grind past the 4% threshold still triggers promptly instead of needing one single big
poll-to-poll jump.

No LLM call is involved — the alert is a template filled in from live numbers, not an
AI-generated report. That means no API key, no billing account, and nothing that can
ever run out of credits. The daily cap (`MAX_FULL_CYCLES_PER_DAY`, default 150) bounds
how many Discord messages can fire in a day in the worst case.

## Paper-trading strategy tracker (`paperTrades.jsonl`)

Every raw signal flag from `detectSignals()` (level breaks, "approaching" flags) opens a
simulated position the moment it fires — one open position per signal type at a time, no
real money, no execution anywhere. Each position closes on whichever comes first: **+5%
target**, **-3% stop**, or a **3-hour time-out**, and gets appended to `paperTrades.jsonl`
with its entry/exit price, MC, timestamps, and a short price snippet around entry and exit
(`entrySnippet`/`exitSnippet`) — that snippet is what lets the dashboard show the actual
formation that triggered the trade when you click into a win.

This is the free, rule-based test of whether each signal flag is actually worth anything —
same honest-by-default approach as the rest of this watcher: no fitted thresholds, no
curve-fitting, results only mean something once enough trades have closed. A live Claude
session periodically reads this file and syncs closed trades into the dashboard's
strategy-wins view, grouped by signal type.

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

- `POLL_INTERVAL_MS` — how often to hit DexScreener (default 15s)
- `MOVE_THRESHOLD_PCT` — cumulative % move since the last alert that triggers one (default 4%)
- `FLASH_THRESHOLD_PCT` / `FLASH_WINDOW_MS` — fast-move trigger (default 2.5% within 60s)
- `FULL_CYCLE_FLOOR_MIN` — heartbeat interval when nothing else fires (default 60min)
- `MAX_FULL_CYCLES_PER_DAY` — safety cap on alerts per day (default 150)
- `PAPER_TARGET_PCT` / `PAPER_STOP_PCT` / `PAPER_MAX_HOLD_MS` — paper-trade exit rules

## Limits, honestly

- GitHub's scheduler for the hourly restart isn't exact and can be delayed during
  platform load — the ~55min-per-run design gives slack for that, but a very late restart
  could still leave a small gap in coverage.
- The estimated position P&L in each alert is computed from live price vs. cost basis
  and can differ slightly from the FOMO app's own displayed P&L (a known, minor
  discrepancy between how the two calculate it) — polling every 15s closes the *timing*
  gap, not small cross-platform differences in how each app rounds or sources price.
- This watcher does **not** write to the GleexhCoin dashboard artifact — that database
  is only reachable from inside a live Claude session. This is a separate, simpler
  channel (Discord) for when no Claude session is running.
- The alerts are templated from data, not AI-written analysis — no catalyst
  interpretation, no chart pattern read, no CEO-style synthesis. That level of judgment
  still comes from the full desk cycle when a Claude session is active.
- Not investment advice; it only reports and never executes trades.
