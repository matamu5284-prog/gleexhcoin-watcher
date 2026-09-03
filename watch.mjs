// GleexhCoin autonomous UBIK watcher.
// Cheap path (every run): fetch price/MC from DexScreener's free public API, compare to last
// saved state. No API calls, no cost.
// Expensive path (only on a real trigger): call Anthropic's API once for an 8-agent-style
// synthesis, post it to Discord. Hard-capped per day so cost can never run away.

const TOKEN_ADDRESS = "0x812486eaea648819853f8e372dc9f1516c7868bd";
const MOVE_THRESHOLD_PCT = 4; // escalate if MC moved this much since the last full cycle
const FULL_CYCLE_FLOOR_MIN = 30; // force a full cycle at least this often regardless
const MAX_FULL_CYCLES_PER_DAY = 30; // hard safety cap on paid API calls
const MODEL = "claude-haiku-4-5-20251001"; // cheap, fast model for this job

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_WORKSPACE_ID = process.env.ANTHROPIC_WORKSPACE_ID;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

function fmtUsd(n) {
  if (n == null || Number.isNaN(n)) return "—";
  if (Math.abs(n) >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (Math.abs(n) >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + n.toFixed(6);
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

async function callClaude(market, state, trigger) {
  const pnlPct = (((market.price - state.position.invested / state.position.held) /
    (state.position.invested / state.position.held)) * 100);
  const prompt = `You are gleexh.ape, CEO of GleexhCoin, a memecoin trading demo desk. You just got fresh data on UBIK (Robinhood Chain memecoin) from your 8 sector agents (Volt=volume/data, Radar=new launches, Warden=risk/security, Echo=news, Custodian=position mgmt, Pivot=technical analysis, Sonar=holder flow, Tide=macro). Give ONE concise report (under 150 words, plain text, no markdown headers) for the owner, covering: what changed, the current price/MC vs key levels (support $7.59M, pivot $9.03M already broken/now support, resistance $11.19M, ATH $13.82M), and a clear call (HOLD / ADD / TAKE PARTIAL PROFIT / EXIT) with one-line reasoning. Never say to execute a trade for them — you only advise, the owner presses every button.

Trigger for this report: ${trigger}
Current price: $${market.price}
Current MC: ${fmtUsd(market.mc)}
24h change: ${market.change24h}%
1h change: ${market.change1h}%
Liquidity: ${fmtUsd(market.liquidity)}
24h volume: ${fmtUsd(market.volume24h)}
Owner position: ${state.position.held} UBIK, $${state.position.invested} invested, avg entry MC ${fmtUsd(state.position.avgEntryMc)}, current unrealized ~${pnlPct.toFixed(1)}%
Last call issued: ${state.lastCall}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      ...(ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": ANTHROPIC_WORKSPACE_ID } : {}),
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.content?.[0]?.text || "(no response)";
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
    const report = await callClaude(market, state, trigger);
    await postToDiscord(`**GleexhCoin Desk — ${trigger}**\n${report}`);
    state.lastFullCycleAt = new Date().toISOString();
    state.fullCyclesToday += 1;
  } else if (trigger && capped) {
    console.log("Trigger fired but daily full-cycle cap reached — staying quiet, cheap-check only.");
  }

  state.lastMc = market.mc;
  saveState(state);
}

main().catch((err) => {
  console.error("Watcher failed:", err);
  process.exit(1);
});
