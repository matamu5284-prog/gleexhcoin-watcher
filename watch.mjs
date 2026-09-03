// GleexhCoin autonomous UBIK watcher.
// Cheap path (every run): fetch price/MC from DexScreener's free public API, compare to last
// saved state. No API calls, no cost.
// Trigger path (only on a real trigger): post a templated Discord alert built directly from the
// live data — no LLM call, no billing dependency, completely free.

const TOKEN_ADDRESS = "0x812486eaea648819853f8e372dc9f1516c7868bd";
const MOVE_THRESHOLD_PCT = 4; // escalate if MC moved this much since the last full cycle
const FULL_CYCLE_FLOOR_MIN = 10; // force a full cycle at least this often regardless
const MAX_FULL_CYCLES_PER_DAY = 150; // safety cap on how many alerts can fire per day (10-min floor implies up to ~144/day from staleness alone)

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

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

async function fetchMarketData() {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${TOKEN_ADDRESS}`);
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

function crossedLevel(prevMc, curMc, levels) {
  const vals = Object.entries(levels);
  for (const [name, level] of vals) {
    if ((prevMc < level && curMc >= level) || (prevMc > level && curMc <= level)) {
      return { name, level };
    }
  }
  return null;
}

import { readFileSync, writeFileSync } from "node:fs";

function loadState() {
  return JSON.parse(readFileSync("state.json", "utf8"));
}

function saveState(state) {
  writeFileSync("state.json", JSON.stringify(state, null, 2) + "\n");
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

function buildAlertMessage(market, state, trigger) {
  const costBasis = state.position.invested / state.position.held;
  const currentValue = state.position.held * market.price;
  const pnlPct = ((market.price - costBasis) / costBasis) * 100;
  const pnlUsd = currentValue - state.position.invested;

  const { below, above } = nearestLevels(market.mc, state.levels);
  const belowStr = below ? `${LEVEL_LABELS[below.key]} ${fmtUsd(below.val)}` : "—";
  const aboveStr = above
    ? `${LEVEL_LABELS[above.key]} ${fmtUsd(above.val)} (${(((above.val - market.mc) / market.mc) * 100).toFixed(1)}% away)`
    : "—";

  const lines = [
    `**GleexhCoin Desk — ${trigger}**`,
    ``,
    `**UBIK** — Price: $${market.price.toFixed(6)}  |  MC: ${fmtUsd(market.mc)}`,
    `5m: ${fmtPct(market.change5m)}  1h: ${fmtPct(market.change1h)}  24h: ${fmtPct(market.change24h)}`,
    `Liquidity: ${fmtUsd(market.liquidity)}  |  24h Vol: ${fmtUsd(market.volume24h)}`,
    ``,
    `Nearest support: ${belowStr}`,
    `Nearest resistance: ${aboveStr}`,
    ``,
    `**Position:** ${state.position.held.toLocaleString()} UBIK, $${state.position.invested} invested (avg entry MC ${fmtUsd(state.position.avgEntryMc)})`,
    `Estimated value: ~$${currentValue.toFixed(2)} (${fmtPct(pnlPct)}, ~$${pnlUsd.toFixed(2)})`,
    `_Estimated from live price vs. cost basis — may differ slightly from the FOMO app's own displayed P&L._`,
    ``,
    `Standing call: **${state.lastCall}** (report only — no trades executed automatically)`,
    ``,
    `Full level ladder:`,
    levelLadder(market.mc, state.levels),
  ];
  return lines.join("\n");
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

async function main() {
  const state = loadState();
  const market = await fetchMarketData();

  const today = new Date().toISOString().slice(0, 10);
  if (state.fullCyclesDate !== today) {
    state.fullCyclesDate = today;
    state.fullCyclesToday = 0;
  }

  const prevMc = state.lastMc || market.mc;
  const pctMove = Math.abs((market.mc - prevMc) / prevMc) * 100;
  const cross = crossedLevel(prevMc, market.mc, state.levels);
  const minutesSinceLastFull = state.lastFullCycleAt
    ? (Date.now() - new Date(state.lastFullCycleAt).getTime()) / 60000
    : Infinity;
  const liquidityCollapsed = market.liquidity != null && market.liquidity < 5000;

  let trigger = null;
  if (liquidityCollapsed) trigger = "LIQUIDITY COLLAPSE — possible dead token";
  else if (cross) trigger = `Level crossed: ${cross.name} (${fmtUsd(cross.level)})`;
  else if (pctMove >= MOVE_THRESHOLD_PCT) trigger = `MC moved ${pctMove.toFixed(1)}% since last full cycle`;
  else if (minutesSinceLastFull >= FULL_CYCLE_FLOOR_MIN) trigger = `${FULL_CYCLE_FLOOR_MIN}-minute staleness floor`;

  const capped = state.fullCyclesToday >= MAX_FULL_CYCLES_PER_DAY;

  console.log(`price=$${market.price} mc=${fmtUsd(market.mc)} prevMc=${fmtUsd(prevMc)} move=${pctMove.toFixed(2)}% trigger=${trigger || "none"} capped=${capped}`);

  if (trigger && !capped) {
    const message = buildAlertMessage(market, state, trigger);
    await postToDiscord(message);
    state.lastFullCycleAt = new Date().toISOString();
    state.fullCyclesToday += 1;
  } else if (trigger && capped) {
    console.log("Trigger fired but daily alert cap reached — staying quiet, cheap-check only.");
  }

  state.lastMc = market.mc;
  saveState(state);
}

main().catch((err) => {
  console.error("Watcher failed:", err);
  process.exit(1);
});
