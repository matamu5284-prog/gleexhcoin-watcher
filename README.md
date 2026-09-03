# GleexhCoin UBIK Watcher

Autonomous, free-to-host companion to the GleexhCoin desk. Runs on GitHub Actions —
no computer needs to stay on, no Claude session needs to stay alive.

## How it works

Every 5 minutes, GitHub Actions runs `watch.mjs`:

1. **Cheap path (always, $0):** fetches UBIK's price/MC/liquidity/volume from
   DexScreener's free public API and compares it to the last saved value in `state.json`.
   No AI call happens here.
2. **Expensive path (only on a real trigger):** if the market cap moved ≥4% since the
   last full cycle, crossed a key level, liquidity looks like it collapsed, or 30 minutes
   have passed since the last check-in — it calls the Anthropic API **once**
   (`claude-haiku-4-5`, the cheap/fast model) for a short CEO-style report, and posts it
   to your Discord webhook.
3. Otherwise it stays completely silent and just updates `state.json`.

**Hard cost cap:** `MAX_FULL_CYCLES_PER_DAY` in `watch.mjs` (default 30) caps how many
paid API calls can happen in a day, no matter what. Even in the worst case (constant
triggering), this cannot exceed that many Anthropic API calls per day.

This uses **your own Anthropic API key**, billed separately from any Claude Code
session — it cannot affect token usage on any other project.

## One-time setup

You need to add two repo secrets (Settings → Secrets and variables → Actions → New
repository secret). Never paste these into a chat with an AI — add them directly on
GitHub.

1. **`ANTHROPIC_API_KEY`** — get one at https://console.anthropic.com (Settings → API
   Keys → Create Key). Anthropic API billing is pay-as-you-go; Haiku calls here are a
   fraction of a cent each, and the daily cap above bounds the worst case.
2. **`DISCORD_WEBHOOK_URL`** — already set for you as part of this build.
3. **`ANTHROPIC_WORKSPACE_ID`** — only needed if your API key is an "identity-linked"
   key (Anthropic's newer key type tied to your account across workspaces, instead of
   one workspace). If the workflow fails with `anthropic-workspace-id is required`,
   find your workspace ID at console.anthropic.com → Settings → Workspaces (it's in
   the URL, or the workspace's own settings page) and add it as this secret the same
   way.

That's it. The workflow (`.github/workflows/watch.yml`) is already scheduled — once
`ANTHROPIC_API_KEY` is added, it starts working within a few minutes on its own.

## Tuning

Edit the constants at the top of `watch.mjs`:

- `MOVE_THRESHOLD_PCT` — how big a market cap move triggers a full report (default 4%)
- `FULL_CYCLE_FLOOR_MIN` — max minutes between forced check-ins even if nothing moves (default 30)
- `MAX_FULL_CYCLES_PER_DAY` — hard cost ceiling (default 30)
- `MODEL` — which Claude model to use (default the cheapest current one)

## Limits, honestly

- GitHub's free scheduler isn't exact below ~5 minutes and can be delayed during
  platform load — treat "every 5 min" as "close to every 5 min," not a guarantee.
- This watcher does **not** write to the GleexhCoin dashboard artifact — that database
  is only reachable from inside a live Claude session. This is a separate, simpler
  channel (Discord) for when no Claude session is running.
- Not investment advice; it only reports and never executes trades.
