// GleexhCoin autonomous portfolio watcher — fast-loop mode, multi-token.
// Runs as one long-lived job (not a one-shot) inside a single GitHub Actions run: polls
// DexScreener's free public API every ~15s per held token, no LLM call, no API key
// required for the core loop, no billing dependency. Posts a templated Discord alert the
// moment a real trigger fires, and a short SMS (via free carrier email-to-SMS gateway) on
// bigger moves — seconds of lag, not the 5-10+ minute lag a scheduled one-shot-per-cron-tick
// design would have. The workflow restarts this job roughly hourly (see
// .github/workflows/watch.yml) since a single GitHub Actions job can't run forever;
// state.json/history.jsonl carry continuity across restarts. Public repos get
// free/unlimited GitHub Actions minutes, so running this near-continuously costs nothing.
//
// Portfolio: add/remove tokens by editing the TOKENS array below. Each token gets its own
// independent state (position, levels, alert baselines, paper trades) under
// state.tokens[symbol] — adding a token does not touch any other token's state.

const TOKENS = [
  {
    symbol: "UBIK",
    address: "0x812486eaea648819853f8e372dc9f1516c7868bd",
    // Optional instant on-chain swap detection (Alchemy free tier — no cost, no card).
    // Leave poolId null to skip on-chain triggers for a token and rely on interval polling only.
    poolId: "0x1f28c0c3938fd48947bdb02c43377534ef0a3ffb23945e68052bcaaec1d2e676", // UBIK/GLD v4 pool id, from DexScreener's pairAddress field
  },
];

const POLL_INTERVAL_MS = 15_000; // how often to hit DexScreener per token — well under their rate limit
const MAX_RUN_MS = 55 * 60 * 1000; // exit cleanly before GitHub's job runtime cap; workflow restarts hourly
const COMMIT_INTERVAL_MS = 2 * 60 * 1000; // flush history/state to git this often, not every poll
const MOVE_THRESHOLD_PCT = 4; // Discord: escalate if MC moved this much since the last alert (not the last poll)
const SMS_MOVE_THRESHOLD_PCT = 7; // SMS: only fires on bigger moves than Discord, since texts are more intrusive
const FLASH_WINDOW_MS = 60_000; // "fast move" lookback window
const FLASH_THRESHOLD_PCT = 2.5; // escalate on a move at least this big within FLASH_WINDOW_MS
const FULL_CYCLE_FLOOR_MIN = 60; // heartbeat only now — real moves are caught near-instantly above
const MAX_FULL_CYCLES_PER_DAY = 150; // safety cap per token, unlikely to be hit under normal operation

// Paper-trading simulation: rule-based, no LLM, tests whether each raw signal flag is
// actually worth anything. One open position per signal type at a time (no pyramiding).
const PAPER_TARGET_PCT = 5; // close a win at +5% from entry
const PAPER_STOP_PCT = 3; // close a loss at -3% from entry
const PAPER_MAX_HOLD_MS = 3 * 60 * 60 * 1000; // force-close after 3h regardless (time-stop)
const PAPER_SNIPPET_SIZE = 6; // price points kept around entry/exit for the dashboard's drill-down chart
const PAPER_TRADES_FILE = "paperTrades.jsonl";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// Free SMS via carrier email-to-SMS gateway (e.g. 7812171812@txt.att.net for AT&T) — sent
// as a plain email through a Gmail account's SMTP relay. Needs a Gmail App Password (not
// the account password) since Gmail blocks plain-password SMTP; generate one at
// myaccount.google.com/apppasswords with 2FA on. All three env vars must be set or SMS is
// skipped entirely (same no-op-if-unconfigured pattern as Discord).
const SMS_TO = process.env.SMS_TO; // e.g. "7812171812@txt.att.net"
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

// Optional instant on-chain swap detection (Alchemy free tier — no cost, no card).
// When ALCHEMY_API_KEY is unset this whole path is a no-op and every token falls back to
// pure interval polling. When set, one shared WebSocket subscription to Uniswap v4's
// PoolManager on Robinhood Chain fires an out-of-cycle poll the instant a swap lands on
// any token's pool id — catching real moves in ~1-3s instead of waiting up to 15s.
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;
const ALCHEMY_WS_URL = ALCHEMY_API_KEY ? `wss://robinhood-chain.g.alchemy.com/v2/${ALCHEMY_API_KEY}` : null;
const POOL_MANAGER_ADDRESS = "0x8366a39cc670b4001a1121b8f6a443a643e40951"; // Uniswap v4 PoolManager on Robinhood Chain (per Uniswap's official deployments doc — addresses differ per chain in v4, confirmed not the same as mainnet/Arbitrum)
const SWAP_TOPIC0 = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"; // keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)")
const EVENT_POLL_MIN_GAP_MS = 3000; // debounce per token so a burst of swaps can't hammer DexScreener faster than this

function fmtUsd(n) {
  if (n == null || Number.isNaN(n)) return "—";
  if (Math.abs(n) >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (Math.abs(n) >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + n.toFixed(6);
}

function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}

async function fetchMarketData(tokenAddress) {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
  if (!res.ok) throw new Error(`DexScreener API error: ${res.status}`);
  const data = await res.json();
  const pair = (data.pairs || []).find((p) => p.chainId === "robinhood") || data.pairs?.[0];
  if (!pair) throw new Error("No pair data returned from DexScreener");
  return {
    price: parseFloat(pair.priceUsd),
    mc: pair.marketCap || pair.fdv,
    liquidity: pair.liquidity?.usd,
    volume24h: pair.volume?.h24,
    change24h: pair.priceChange?.h24,
    change1h: pair.priceChange?.h1,
    change5m: pair.priceChange?.m5,
  };
}

// Only reports the first level crossed if a single poll gap skips multiple at once —
// acceptable now that polls are ~15s apart (previously a known gap at 5-10min polling).
function crossedLevel(prevMc, curMc, levels) {
  const vals = Object.entries(levels);
  for (const [name, level] of vals) {
    if ((prevMc < level && curMc >= level) || (prevMc > level && curMc <= level)) {
      return { name, level };
    }
  }
  return null;
}

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";

// Default per-token state for a token that has no prior history — conservative
// placeholders (flat level ladder, zero position) until the user has real numbers to
// give it, same as how UBIK's state was hand-seeded originally.
function defaultTokenState(market) {
  const mc = market?.mc || 0;
  return {
    lastMc: mc,
    lastAlertMc: mc,
    lastSmsAlertMc: mc,
    lastFullCycleAt: null,
    fullCyclesToday: 0,
    fullCyclesDate: null,
    lastCall: "MONITOR ONLY",
    levels: mc ? { base: mc } : {},
    position: { held: 0, invested: 0, avgEntryMc: mc },
    openPaperTrades: {},
  };
}

// Migrates the old single-token flat state.json shape (pre-portfolio) into
// state.tokens[symbol] the first time this runs against it. No-op once migrated.
function migrateState(state) {
  if (state.tokens) return state;
  const { lastMc, lastFullCycleAt, fullCyclesToday, fullCyclesDate, lastCall, levels, position, openPaperTrades, lastAlertMc } = state;
  const migratedSymbol = TOKENS[0]?.symbol || "UBIK";
  return {
    tokens: {
      [migratedSymbol]: {
        lastMc, lastFullCycleAt, fullCyclesToday, fullCyclesDate, lastCall, levels, position, openPaperTrades,
        lastAlertMc,
        lastSmsAlertMc: lastAlertMc,
      },
    },
  };
}

function loadState() {
  const state = migrateState(JSON.parse(readFileSync("state.json", "utf8")));
  for (const t of TOKENS) {
    if (!state.tokens[t.symbol]) state.tokens[t.symbol] = defaultTokenState(null);
    if (state.tokens[t.symbol].lastSmsAlertMc == null) {
      state.tokens[t.symbol].lastSmsAlertMc = state.tokens[t.symbol].lastAlertMc ?? state.tokens[t.symbol].lastMc ?? 0;
    }
  }
  return state;
}

function saveState(state) {
  writeFileSync("state.json", JSON.stringify(state, null, 2) + "\n");
}

const HISTORY_FILE = "history.jsonl";

// Detects simple, honest signal flags from just this bar + the last bar — no lookahead,
// no fitted parameters. This is raw material for a future backtest, not a validated
// strategy. Every flag here should be explainable in one sentence.
function detectSignals(market, prevMc, cross, levels) {
  const flags = [];
  const { above } = nearestLevels(market.mc, levels);
  if (above && ((above.val - market.mc) / market.mc) * 100 <= 3) {
    flags.push(`approaching_${above.key}`);
  }
  if (cross && market.mc > prevMc) flags.push(`broke_above_${cross.name}`);
  if (cross && market.mc < prevMc) flags.push(`broke_below_${cross.name}`);
  if (market.change5m > 0 && market.change1h > 0 && market.change24h > 0) flags.push("momentum_up_all_timeframes");
  if (market.change5m < 0 && market.change1h < 0 && market.change24h < 0) flags.push("momentum_down_all_timeframes");
  return flags;
}

function appendHistory(symbol, market, cross, signals) {
  const row = {
    t: new Date().toISOString(),
    symbol,
    price: market.price,
    mc: market.mc,
    liquidity: market.liquidity ?? null,
    volume24h: market.volume24h ?? null,
    change5m: market.change5m ?? null,
    change1h: market.change1h ?? null,
    change24h: market.change24h ?? null,
    crossed: cross ? cross.name : null,
    signals,
  };
  appendFileSync(HISTORY_FILE, JSON.stringify(row) + "\n");
}

const LEVEL_LABELS = {
  base: "Base",
  support: "Support",
  pivot: "Pivot",
  resistance: "Resistance",
  ath: "ATH",
  extTarget: "Ext target",
};

function levelLadder(mc, levels) {
  return Object.entries(levels)
    .sort((a, b) => a[1] - b[1])
    .map(([key, val]) => {
      const label = LEVEL_LABELS[key] || key;
      const marker = mc >= val ? "✓" : " ";
      const dist = ((val - mc) / mc) * 100;
      const distStr = mc >= val ? `(cleared)` : `(${dist.toFixed(1)}% away)`;
      return `${marker} ${label}: ${fmtUsd(val)} ${distStr}`;
    })
    .join("\n");
}

function nearestLevels(mc, levels) {
  const sorted = Object.entries(levels).sort((a, b) => a[1] - b[1]);
  let below = null;
  let above = null;
  for (const [key, val] of sorted) {
    if (val <= mc) below = { key, val };
    if (val > mc && !above) above = { key, val };
  }
  return { below, above };
}

function buildAlertMessage(symbol, market, tokenState, trigger) {
  const costBasis = tokenState.position.held ? tokenState.position.invested / tokenState.position.held : 0;
  const currentValue = tokenState.position.held * market.price;
  const pnlPct = costBasis ? ((market.price - costBasis) / costBasis) * 100 : 0;
  const pnlUsd = currentValue - tokenState.position.invested;

  const { below, above } = nearestLevels(market.mc, tokenState.levels);
  const belowStr = below ? `${LEVEL_LABELS[below.key] || below.key} ${fmtUsd(below.val)}` : "—";
  const aboveStr = above
    ? `${LEVEL_LABELS[above.key] || above.key} ${fmtUsd(above.val)} (${(((above.val - market.mc) / market.mc) * 100).toFixed(1)}% away)`
    : "—";

  const lines = [
    `**GleexhCoin Desk — ${trigger}**`,
    ``,
    `**${symbol}** — Price: $${market.price.toFixed(6)}  |  MC: ${fmtUsd(market.mc)}`,
    `5m: ${fmtPct(market.change5m)}  1h: ${fmtPct(market.change1h)}  24h: ${fmtPct(market.change24h)}`,
    `Liquidity: ${fmtUsd(market.liquidity)}  |  24h Vol: ${fmtUsd(market.volume24h)}`,
    ``,
    `Nearest support: ${belowStr}`,
    `Nearest resistance: ${aboveStr}`,
    ``,
    `**Position:** ${tokenState.position.held.toLocaleString()} ${symbol}, $${tokenState.position.invested} invested (avg entry MC ${fmtUsd(tokenState.position.avgEntryMc)})`,
    `Estimated value: ~$${currentValue.toFixed(2)} (${fmtPct(pnlPct)}, ~$${pnlUsd.toFixed(2)})`,
    `_Estimated from live price vs. cost basis — may differ slightly from the FOMO app's own displayed P&L._`,
    ``,
    `Standing call: **${tokenState.lastCall}** (report only — no trades executed automatically)`,
    ``,
    `Full level ladder:`,
    levelLadder(market.mc, tokenState.levels),
  ];
  return lines.join("\n");
}

function buildSmsMessage(symbol, market, cumulativeMovePct) {
  return `GleexhCoin: ${symbol} moved ${cumulativeMovePct >= 0 ? "+" : ""}${cumulativeMovePct.toFixed(1)}% -- price $${market.price.toFixed(6)}, MC ${fmtUsd(market.mc)}. 24h ${fmtPct(market.change24h)}.`;
}

async function postToDiscord(content) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log("No DISCORD_WEBHOOK_URL set, skipping Discord post. Content:\n", content);
    return;
  }
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: content.slice(0, 1900) }),
  });
  if (!res.ok) console.error(`Discord webhook failed: ${res.status} ${await res.text()}`);
}

let smtpTransport = null;
async function getSmtpTransport() {
  if (smtpTransport) return smtpTransport;
  const { default: nodemailer } = await import("nodemailer");
  smtpTransport = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
  return smtpTransport;
}

// Free SMS via carrier email-to-SMS gateway. Silently no-ops if any of SMS_TO /
// GMAIL_USER / GMAIL_APP_PASSWORD are unset — same pattern as Discord above. Most carrier
// gateways strip subjects/HTML, so this sends a bare-text body only, kept short since some
// gateways truncate around 160 chars.
async function postSms(text) {
  if (!SMS_TO || !GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.log("SMS not configured (SMS_TO/GMAIL_USER/GMAIL_APP_PASSWORD), skipping. Text:\n", text);
    return;
  }
  try {
    const transport = await getSmtpTransport();
    await transport.sendMail({ from: GMAIL_USER, to: SMS_TO, subject: "", text: text.slice(0, 300) });
    console.log(`[sms] sent to ${SMS_TO}`);
  } catch (err) {
    console.error("[sms] send failed:", err.message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Subscribes to Uniswap v4 Swap logs for every token in TOKENS that has a poolId, via
// Alchemy's free WebSocket RPC (one shared connection, filtered to all pool ids at once).
// Deliberately does NOT decode price from the log itself (sqrtPriceX96 math is easy to get
// subtly wrong) — it just tells the caller which pool id fired, and the caller re-uses the
// same trusted DexScreener-based poll to get the real numbers for that token. This is a
// no-op (falls back to pure interval polling) when ALCHEMY_API_KEY isn't set.
async function startOnChainWatcher(onSwap, isRunning) {
  const watchedTokens = TOKENS.filter((t) => t.poolId);
  if (!ALCHEMY_WS_URL || watchedTokens.length === 0) {
    console.log("[onchain] Instant on-chain swap detection disabled (no ALCHEMY_API_KEY or no token has a poolId) — using interval polling only.");
    return;
  }
  const { default: WebSocket } = await import("ws");
  let backoffMs = 3000;
  const poolIdToSymbol = new Map(watchedTokens.map((t) => [t.poolId, t.symbol]));

  function connect() {
    if (!isRunning()) return;
    const ws = new WebSocket(ALCHEMY_WS_URL);
    ws.on("open", () => {
      backoffMs = 3000;
      console.log(`[onchain] connected to Robinhood Chain, subscribing to ${watchedTokens.length} pool(s): ${watchedTokens.map((t) => t.symbol).join(", ")}`);
      for (const t of watchedTokens) {
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_subscribe",
          params: ["logs", { address: POOL_MANAGER_ADDRESS, topics: [SWAP_TOPIC0, t.poolId] }],
        }));
      }
    });
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.method === "eth_subscription" && msg.params?.result) {
          const topics = msg.params.result.topics || [];
          const poolId = topics[1];
          const symbol = poolIdToSymbol.get(poolId);
          console.log(`[onchain] swap detected${symbol ? ` on ${symbol} pool` : ""} — triggering instant poll`);
          onSwap(symbol);
        }
      } catch {
        // malformed frame, ignore — the next real event will still come through
      }
    });
    ws.on("close", () => {
      if (!isRunning()) return;
      console.log(`[onchain] disconnected, reconnecting in ${backoffMs / 1000}s`);
      setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30000);
    });
    ws.on("error", (err) => {
      console.error("[onchain] websocket error:", err.message);
    });
  }
  connect();
}

// Skip flags that are just "the market is trending" noise, not a discrete entry signal —
// otherwise every poll during a trend opens a redundant position.
const PAPER_TRADEABLE_SIGNALS = new Set([
  "broke_above_support", "broke_below_support",
  "broke_above_pivot", "broke_below_pivot",
  "broke_above_resistance", "broke_below_resistance",
  "broke_above_ath", "broke_below_ath",
  "broke_above_extTarget", "broke_below_extTarget",
  "approaching_support", "approaching_pivot", "approaching_resistance",
]);

function openPaperTrades(symbol, tokenState, market, signals, rollingBuffer) {
  if (!tokenState.openPaperTrades) tokenState.openPaperTrades = {};
  for (const sig of signals) {
    if (!PAPER_TRADEABLE_SIGNALS.has(sig)) continue;
    if (tokenState.openPaperTrades[sig]) continue; // one open position per signal type
    tokenState.openPaperTrades[sig] = {
      signal: sig,
      entryAt: new Date().toISOString(),
      entryPrice: market.price,
      entryMc: market.mc,
      entrySnippet: rollingBuffer.slice(-PAPER_SNIPPET_SIZE),
    };
    console.log(`[paper] ${symbol}: opened ${sig} @ ${fmtUsd(market.mc)}`);
  }
}

function closePaperTrades(symbol, tokenState, market, rollingBuffer) {
  if (!tokenState.openPaperTrades) return;
  const now = Date.now();
  for (const sig of Object.keys(tokenState.openPaperTrades)) {
    const t = tokenState.openPaperTrades[sig];
    const pctReturn = ((market.price - t.entryPrice) / t.entryPrice) * 100;
    const ageMs = now - new Date(t.entryAt).getTime();
    let exitReason = null;
    if (pctReturn >= PAPER_TARGET_PCT) exitReason = "target";
    else if (pctReturn <= -PAPER_STOP_PCT) exitReason = "stop";
    else if (ageMs >= PAPER_MAX_HOLD_MS) exitReason = "timeout";
    if (!exitReason) continue;

    const record = {
      symbol,
      signal: sig,
      entryAt: t.entryAt,
      exitAt: new Date().toISOString(),
      entryPrice: t.entryPrice,
      entryMc: t.entryMc,
      exitPrice: market.price,
      exitMc: market.mc,
      pctReturn: Number(pctReturn.toFixed(2)),
      result: pctReturn > 0 ? "win" : "loss",
      exitReason,
      entrySnippet: t.entrySnippet,
      exitSnippet: rollingBuffer.slice(-PAPER_SNIPPET_SIZE),
    };
    appendFileSync(PAPER_TRADES_FILE, JSON.stringify(record) + "\n");
    console.log(`[paper] ${symbol}: closed ${sig} — ${record.result} ${record.pctReturn}% (${exitReason})`);
    delete tokenState.openPaperTrades[sig];
  }
}

function run(cmd) {
  return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

// Commits are batched (not one per poll) to avoid hammering git with a push every 15s.
// Failures are logged and swallowed — a missed commit just means the next flush picks it
// up; it must never crash the polling loop.
function flushToGit() {
  try {
    const status = run("git status --porcelain -- state.json history.jsonl paperTrades.jsonl");
    if (!status) return;
    run("git add state.json history.jsonl paperTrades.jsonl");
    run(`git commit -m "state + history update (fast loop) [skip ci]"`);
    try {
      run("git pull --rebase --autostash origin main");
    } catch (e) {
      console.error("git pull --rebase failed, pushing anyway:", e.message);
    }
    run("git push");
    console.log(`[git] flushed at ${new Date().toISOString()}`);
  } catch (err) {
    console.error("[git] flush failed, will retry next interval:", err.message);
  }
}

async function pollToken(tokenCfg, state, perTokenTransient) {
  const { symbol, address } = tokenCfg;
  const tokenState = state.tokens[symbol];
  const { recentPolls, rollingBuffer } = perTokenTransient;

  const market = await fetchMarketData(address);
  const now = Date.now();

  rollingBuffer.push({ t: new Date().toISOString(), price: market.price, mc: market.mc });
  if (rollingBuffer.length > 40) rollingBuffer.shift();

  const today = new Date().toISOString().slice(0, 10);
  if (tokenState.fullCyclesDate !== today) {
    tokenState.fullCyclesDate = today;
    tokenState.fullCyclesToday = 0;
  }

  const prevPollMc = tokenState.lastMc || market.mc;
  const alertBaselineMc = tokenState.lastAlertMc || tokenState.lastMc || market.mc;
  const smsBaselineMc = tokenState.lastSmsAlertMc || alertBaselineMc;
  const cross = crossedLevel(prevPollMc, market.mc, tokenState.levels);
  const cumulativeMovePct = Math.abs((market.mc - alertBaselineMc) / alertBaselineMc) * 100;
  const cumulativeSmsMovePct = Math.abs((market.mc - smsBaselineMc) / smsBaselineMc) * 100;
  const liquidityCollapsed = market.liquidity != null && market.liquidity < 5000;
  const minutesSinceLastFull = tokenState.lastFullCycleAt
    ? (now - new Date(tokenState.lastFullCycleAt).getTime()) / 60000
    : Infinity;

  // flash-move check: biggest % swing within the last FLASH_WINDOW_MS of polls
  recentPolls.push({ t: now, mc: market.mc });
  while (recentPolls.length && now - recentPolls[0].t > FLASH_WINDOW_MS) recentPolls.shift();
  const windowMcs = recentPolls.map((p) => p.mc);
  const flashPct = windowMcs.length > 1
    ? (Math.max(...windowMcs) - Math.min(...windowMcs)) / Math.min(...windowMcs) * 100
    : 0;

  let trigger = null;
  if (liquidityCollapsed) trigger = "LIQUIDITY COLLAPSE — possible dead token";
  else if (cross) trigger = `Level crossed: ${cross.name} (${fmtUsd(cross.level)})`;
  else if (flashPct >= FLASH_THRESHOLD_PCT) trigger = `FLASH MOVE — ${flashPct.toFixed(1)}% within ${FLASH_WINDOW_MS / 1000}s`;
  else if (cumulativeMovePct >= MOVE_THRESHOLD_PCT) trigger = `MC moved ${cumulativeMovePct.toFixed(1)}% since last alert`;
  else if (minutesSinceLastFull >= FULL_CYCLE_FLOOR_MIN) trigger = `${FULL_CYCLE_FLOOR_MIN}-minute heartbeat`;

  const capped = tokenState.fullCyclesToday >= MAX_FULL_CYCLES_PER_DAY;
  const signals = detectSignals(market, prevPollMc, cross, tokenState.levels);
  appendHistory(symbol, market, cross, signals);

  closePaperTrades(symbol, tokenState, market, rollingBuffer); // check exits before opening new ones
  openPaperTrades(symbol, tokenState, market, signals, rollingBuffer);

  console.log(
    `[${new Date().toISOString()}] ${symbol} price=$${market.price} mc=${fmtUsd(market.mc)} ` +
    `cumMove=${cumulativeMovePct.toFixed(2)}% flash=${flashPct.toFixed(2)}% ` +
    `trigger=${trigger || "none"} capped=${capped} signals=${signals.join(",") || "none"}`
  );

  if (trigger && !capped) {
    const message = buildAlertMessage(symbol, market, tokenState, trigger);
    await postToDiscord(message);
    tokenState.lastFullCycleAt = new Date().toISOString();
    tokenState.fullCyclesToday += 1;
    tokenState.lastAlertMc = market.mc; // reset the cumulative-move baseline on every alert
  } else if (trigger && capped) {
    console.log(`Trigger fired for ${symbol} but daily alert cap reached — staying quiet, cheap-check only.`);
  }

  // SMS fires independently of Discord's baseline/cap — only on a bigger cumulative move,
  // so texts stay rare even if Discord is alerting frequently on smaller 4% moves.
  if (!liquidityCollapsed && cumulativeSmsMovePct >= SMS_MOVE_THRESHOLD_PCT) {
    const signedMovePct = ((market.mc - smsBaselineMc) / smsBaselineMc) * 100;
    await postSms(buildSmsMessage(symbol, market, signedMovePct));
    tokenState.lastSmsAlertMc = market.mc;
  } else if (liquidityCollapsed) {
    // Liquidity collapse is urgent enough to text regardless of the % baseline.
    await postSms(`GleexhCoin: ${symbol} LIQUIDITY COLLAPSE — price $${market.price.toFixed(6)}, check Discord/dashboard.`);
    tokenState.lastSmsAlertMc = market.mc;
  }

  tokenState.lastMc = market.mc;
}

async function main() {
  const state = loadState();
  const perTokenTransient = new Map(TOKENS.map((t) => [t.symbol, { recentPolls: [], rollingBuffer: [] }]));
  const startTime = Date.now();
  let lastCommit = Date.now();
  const lastPollAtBySymbol = new Map();
  const pollBusyBySymbol = new Map();
  let running = true;

  async function triggeredPoll(symbol) {
    const targets = symbol ? TOKENS.filter((t) => t.symbol === symbol) : TOKENS;
    for (const t of targets) {
      const now = Date.now();
      const lastPollAt = lastPollAtBySymbol.get(t.symbol) || 0;
      if (pollBusyBySymbol.get(t.symbol) || now - lastPollAt < EVENT_POLL_MIN_GAP_MS) continue;
      pollBusyBySymbol.set(t.symbol, true);
      lastPollAtBySymbol.set(t.symbol, now);
      try {
        await pollToken(t, state, perTokenTransient.get(t.symbol));
      } catch (err) {
        console.error(`Poll failed for ${t.symbol}, will retry next interval:`, err.message);
      } finally {
        pollBusyBySymbol.set(t.symbol, false);
      }
    }
    saveState(state);
  }

  startOnChainWatcher((symbol) => { triggeredPoll(symbol); }, () => running).catch((err) => {
    console.error("[onchain] failed to start, continuing on interval polling only:", err.message);
  });

  console.log(
    `Fast-loop watcher starting — polling ${TOKENS.map((t) => t.symbol).join(", ")} every ${POLL_INTERVAL_MS / 1000}s ` +
    `for up to ${(MAX_RUN_MS / 60000).toFixed(0)} min` + (ALCHEMY_WS_URL ? ", plus instant on-chain swap triggers." : ".")
  );

  while (Date.now() - startTime < MAX_RUN_MS) {
    await triggeredPoll(null);
    if (Date.now() - lastCommit >= COMMIT_INTERVAL_MS) {
      flushToGit();
      lastCommit = Date.now();
    }
    await sleep(POLL_INTERVAL_MS);
  }

  running = false;
  flushToGit();
  console.log("Fast-loop watcher exiting cleanly — workflow will restart it shortly.");
}

main().catch((err) => {
  console.error("Watcher failed:", err);
  flushToGit();
  process.exit(1);
});
