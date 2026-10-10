#!/usr/bin/env node
/**
 * Scores the forced-flow trap check against real outcomes.
 *
 *   node scripts/flow-report.mjs [path/to/decisions.jsonl]
 *   (set BINANCE_PROXY_URL if Binance is geo-blocked from where you run this)
 *
 * PART A — OI threshold sweep on PAST trades (works today, no new data needed).
 *   For every settled WIN/LOSS decision, looks up Binance open interest just
 *   before entry (free 5m history, which Binance only keeps for roughly the
 *   latest 30 days — older trades are skipped and counted) and shows, for each
 *   candidate OF_TRAP_OI_DROP_PCT, how many trades it would have blocked and
 *   whether those were mostly losers. This checks the OI half only: Binance has
 *   no free historical liquidation data, so that half can only be tuned from
 *   what the live feed logs (liq_aligned_ratio / liq_aligned_usd per decision).
 *
 * PART B — VETO SCORECARD (fills up once OF_REQUIRE_TRAP_CHECK is live).
 *   Every refused entry is journalled as a `veto` record. This replays each one:
 *   did the market end the way the blocked trade needed? Uses Binance perp
 *   prices as a stand-in for the venue's oracle, so trades that ended within a
 *   hair of the reference price are unreliable — treat as approximate.
 *
 * Read-only: touches nothing but the journal file you point it at.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MIN = 60_000;
const SYMBOL = { BTC: "BTCUSDT", ETH: "ETHUSDT" };
// Binance's openInterestHist only serves roughly the latest 30 days and
// REJECTS (HTTP 400) any request whose startTime is older, rather than
// truncating it. Stay inside with a margin.
const OI_HISTORY_MS = 29 * 24 * 60 * MIN;

// ---------------------------------------------------------------- pure logic

export function parseJournal(text) {
  return text.split("\n").filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

/** Settled WIN/LOSS decisions (last record per market wins, same as the bot). */
export function settledTrades(records) {
  const dec = new Map(), set = new Map();
  for (const r of records) {
    if (r.type === "decision" && (r.action === "TRADE_UP" || r.action === "TRADE_DOWN")) dec.set(r.market_id, r);
    else if (r.type === "settlement") set.set(r.market_id, r);
  }
  const out = [];
  for (const [id, d] of dec) {
    const s = set.get(id);
    if (!s || (s.outcome !== "WIN" && s.outcome !== "LOSS")) continue; // VOID excluded, as in the bot's stats
    out.push({ id, asset: d.asset, signal: d.signal, t: Date.parse(d.timestamp), expiry: d.expiry_ms ?? null, symbol: d.symbol, win: s.outcome === "WIN", pnl: s.pnl, dry: !!d.dry_run });
  }
  return out;
}

/** Split trades into those Binance can still give OI for, and those too old. */
export function splitByHistory(trades, now) {
  const floor = now - OI_HISTORY_MS + 15 * MIN; // need a little history before each entry
  return {
    fetchable: trades.filter((t) => t.t >= floor),
    tooOld: trades.filter((t) => t.t < floor),
  };
}

/** OI % change over the last 5m bucket before time t. series: [{t, oi}] ascending. null if not covered. */
export function oiChangeBefore(series, t) {
  let i = -1;
  for (let k = 0; k < series.length; k++) { if (series[k].t <= t) i = k; else break; }
  if (i < 1) return null;
  const now = series[i];
  if (t - now.t > 10 * MIN) return null; // gap in the series — don't trust it
  let prev = null;
  for (let k = i - 1; k >= 0; k--) { if (series[k].t <= now.t - 5 * MIN) { prev = series[k]; break; } }
  return prev ? (now.oi / prev.oi - 1) * 100 : null;
}

/** For each candidate OI-drop threshold: what would blocking trades at/below it have done? */
export function sweepOi(rows, thresholds) {
  const usable = rows.filter((r) => r.oiChg !== null);
  const wr = (a) => (a.length ? (100 * a.filter((r) => r.win).length) / a.length : NaN);
  return {
    usable: usable.length,
    skipped: rows.length - usable.length,
    baseline: { n: usable.length, wr: wr(usable), pnl: usable.reduce((s, r) => s + r.pnl, 0) },
    rows: thresholds.map((T) => {
      const blocked = usable.filter((r) => r.oiChg <= -T);
      const kept = usable.filter((r) => r.oiChg > -T);
      return {
        T, blocked: blocked.length, blockedWr: wr(blocked), keptWr: wr(kept),
        // positive = money the block would have saved (blocked trades lost money overall)
        saved: -blocked.reduce((s, r) => s + r.pnl, 0),
      };
    }),
  };
}

/** Price at time x from 1m klines: close of the last candle that had fully closed by x. */
export function priceAt(klines, x) {
  let p = null;
  for (const k of klines) { if (Number(k[0]) + MIN <= x) p = Number(k[4]); else break; }
  return p;
}

/** % move from `from` to `to`, signed so + means the price moved the trade's way. */
export function alignedMove(signal, from, to) {
  if (!(from > 0) || !(to > 0)) return null;
  const pct = (to / from - 1) * 100;
  return signal === "UP" ? pct : -pct;
}

/** Would the vetoed trade have won? close/ref from Binance perp prices. */
export function scoreVeto(signal, ref, close) {
  if (!(ref > 0) || !(close > 0)) return null;
  if (close === ref) return null; // dead heat — can't call it
  return signal === "UP" ? close > ref : close < ref;
}

// ------------------------------------------------------------------- network

async function getJson(url) {
  const opts = {};
  if (process.env.BINANCE_PROXY_URL) {
    const { ProxyAgent } = await import("undici");
    opts.dispatcher = new ProxyAgent(process.env.BINANCE_PROXY_URL);
  }
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}\n  ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/**
 * Fetch Binance's 5m OI history. Observed behaviour: given a startTime/endTime
 * range wider than one page, Binance returns the LATEST `limit` rows ending at
 * endTime and ignores startTime — so paging forward from startTime silently
 * only ever returns the most recent ~41 hours. Instead walk BACKWARD in
 * 40-hour chunks (480 samples, always under the 500-row page), so every request
 * fits in a single page and the answer is complete no matter how Binance
 * resolves the range. A failing chunk (e.g. past Binance's history limit) stops
 * the walk and keeps what was already collected.
 */
export async function oiSeries(asset, fromMs, toMs, fetchJson = getJson) {
  const byT = new Map();
  const CHUNK = 40 * 60 * MIN;
  const lo = fromMs - 15 * MIN;
  let end = Math.min(toMs + 5 * MIN, Date.now());
  let calls = 0;
  while (end > lo && calls < 200) {
    const start = Math.max(lo, end - CHUNK);
    let rows;
    try {
      rows = await fetchJson(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${SYMBOL[asset]}&period=5m&limit=500&startTime=${start}&endTime=${end}`);
    } catch (e) {
      console.error(`  (OI fetch stopped at ${new Date(start).toISOString()}: ${String(e.message).split("\n")[0]})`);
      break;
    }
    calls++;
    if (Array.isArray(rows)) for (const r of rows) if (r.timestamp >= start && r.timestamp <= end) byT.set(r.timestamp, Number(r.sumOpenInterest));
    end = start - 1;
  }
  const series = [...byT].map(([t, oi]) => ({ t, oi })).sort((a, b) => a.t - b.t);
  return { series, pages: calls };
}

async function klinesAround(asset, fromMs, toMs) {
  const rows = await getJson(`https://fapi.binance.com/fapi/v1/klines?symbol=${SYMBOL[asset]}&interval=1m&startTime=${fromMs}&endTime=${toMs}&limit=1500`);
  return Array.isArray(rows) ? rows : [];
}

async function closeAt(asset, expiryMs) {
  const rows = await getJson(`https://fapi.binance.com/fapi/v1/klines?symbol=${SYMBOL[asset]}&interval=1m&startTime=${expiryMs - MIN}&limit=1`);
  return rows?.[0] ? Number(rows[0][4]) : null;
}

// ----------------------------------------------------------------------- CLI

const f1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : "  - ");

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const detail = process.argv.includes("--detail");
  const path = args[0] ?? process.env.JOURNAL_PATH ?? "logs/decisions.jsonl";
  if (!existsSync(path)) { console.error(`no journal at ${path}`); process.exit(1); }
  const records = parseJournal(readFileSync(path, "utf8"));

  // ---- Part A
  const trades = settledTrades(records);
  console.log(`\nPART A — OI threshold sweep on ${trades.length} settled trades`);
  const rows = [];
  for (const asset of ["BTC", "ETH"]) {
    const { fetchable, tooOld } = splitByHistory(trades.filter((t) => t.asset === asset), Date.now());
    for (const t of tooOld) rows.push({ ...t, oiChg: null });
    if (!fetchable.length) continue;
    const { series, pages } = await oiSeries(asset, Math.min(...fetchable.map((t) => t.t)), Math.max(...fetchable.map((t) => t.t)));
    const iso = (ms) => new Date(ms).toISOString().slice(0, 16) + "Z";
    console.log(
      series.length
        ? `  OI coverage ${asset}: ${iso(series[0].t)} -> ${iso(series[series.length - 1].t)} (${series.length} samples, ${pages} pages) vs ${fetchable.length} trades from ${iso(Math.min(...fetchable.map((t) => t.t)))} to ${iso(Math.max(...fetchable.map((t) => t.t)))}`
        : `  OI coverage ${asset}: NO samples returned (${pages} pages) for ${fetchable.length} trades`
    );
    for (const t of fetchable) rows.push({ ...t, oiChg: oiChangeBefore(series, t.t) });
  }
  const tooOldN = rows.filter((r) => r.oiChg === null && r.t < Date.now() - OI_HISTORY_MS + 15 * MIN).length;
  const sw = sweepOi(rows, [0.1, 0.2, 0.3, 0.4, 0.5, 0.8]);
  console.log(`  usable ${sw.usable}; skipped ${sw.skipped} = ${tooOldN} older than ~29 days + ${sw.skipped - tooOldN} inside the window but with no OI sample near entry`);
  console.log(`  all trades: n=${sw.baseline.n}  win rate ${f1(sw.baseline.wr)}%  pnl ${sw.baseline.pnl.toFixed(2)}`);
  console.log("  block if OI fell by >=   blocked   blocked WR   kept WR   pnl saved");
  for (const r of sw.rows) {
    console.log(`  ${String(r.T).padEnd(24)} ${String(r.blocked).padEnd(9)} ${(f1(r.blockedWr) + "%").padEnd(12)} ${(f1(r.keptWr) + "%").padEnd(9)} ${r.saved.toFixed(2)}`);
  }
  console.log("  Look for a threshold where blocked WR is clearly below kept WR on a meaningful n. With few");
  console.log("  blocked trades, a single result can swing it — don't tune to noise.");

  // ---- Detail: one line per usable trade, to see HOW each was entered
  if (detail) {
    const f2 = (n) => (n === null || !Number.isFinite(n) ? "   -  " : (n >= 0 ? "+" : "") + n.toFixed(2));
    console.log("\nDETAIL — usable trades (local = this machine's timezone)");
    console.log("  * = % price move, signed so + means price moved the trade's way");
    console.log("  local time          UTC          asset dir   result   pnl     OI chg   prior5m*  to-expiry*  OI-veto@0.30");
    const usable = rows.filter((r) => r.oiChg !== null).sort((a, b) => a.t - b.t);
    for (const r of usable) {
      let prior = null, after = null;
      try {
        const ks = await klinesAround(r.asset, r.t - 8 * MIN, (r.expiry ?? r.t + 15 * MIN) + 2 * MIN);
        const pEntry = priceAt(ks, r.t), pPrev = priceAt(ks, r.t - 5 * MIN);
        prior = alignedMove(r.signal, pPrev, pEntry);
        if (r.expiry) after = alignedMove(r.signal, pEntry, priceAt(ks, r.expiry));
      } catch { /* price context is a bonus; leave blank */ }
      const d = new Date(r.t);
      console.log(
        `  ${d.toLocaleString("sv-SE").slice(0, 16)}  ${d.toISOString().slice(5, 16)}Z  ${r.asset.padEnd(5)} ${r.signal.padEnd(5)} ${(r.win ? "WIN" : "LOSS").padEnd(7)} ${r.pnl.toFixed(2).padStart(7)}  ${f2(r.oiChg).padStart(7)}  ${f2(prior).padStart(8)}  ${f2(after).padStart(10)}  ${r.oiChg <= -0.3 ? "WOULD BLOCK (OI half)" : "no"}`
      );
    }
  }

  // ---- Part B
  const vetoes = records.filter((r) => r.type === "veto");
  console.log(`\nPART B — veto scorecard (${vetoes.length} vetoed entries)`);
  if (!vetoes.length) { console.log("  none yet."); return; }
  let right = 0, wrong = 0, unknown = 0;
  for (const v of vetoes) {
    let would = null;
    try { if (v.expiry_ms && v.ref_price && v.expiry_ms < Date.now()) would = scoreVeto(v.signal, v.ref_price, await closeAt(v.asset, v.expiry_ms)); } catch { /* leave unknown */ }
    if (would === null) unknown++; else if (would) wrong++; else right++;
    console.log(`  ${v.timestamp}  ${v.asset} ${v.signal}  ${v.reason}  -> ${would === null ? "unscored" : would ? "WOULD HAVE WON (bad veto)" : "would have lost (good veto)"}`);
  }
  console.log(`  good vetoes ${right}, bad vetoes ${wrong}, unscored ${unknown}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
