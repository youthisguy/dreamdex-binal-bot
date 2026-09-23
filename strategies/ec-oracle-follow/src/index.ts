/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// oracle-follow — a directional TAKER for DreamDEX event contracts. It forms a
// view on where BTC/ETH is heading, then crosses the book only when the market
// is offering the favoured leg cheaper than that view says it's worth.
//
// It follows the ec-starter taker skeleton; the new part is a signal step
// (read the underlying price feed, turn it into a probability) and an edge gate
// in front of the cross. Three things are worth understanding before you edit it:
//
//   • A bearish view is BUY_NO, never SELL_YES. A sell escrows the token being
//     sold, so a naked short is impossible here. Because the bot only ever
//     buys, it needs no mint-a-pair inventory seeding at all.
//   • The DIRECTION comes from the UNDERLYING price, never from the book. Taking
//     a view off the book you're about to cross is circular — you'd be chasing
//     your own target. See signal.ts.
//   • The LEVEL comes from the contract when it can be read (strike or opening
//     price), and from the market mid plus a momentum tilt when it cannot.
//     See signal.ts and the README.
//
// It opens positions and stops there — redeeming winners after settlement is
// ec-settlement's job.
//
// DRY_RUN=true (default) logs the takes it would make and never opens a signer.
// Set DRY_RUN=false + a funded PRIVATE_KEY to trade for real.
//
//   npm start -w ec-oracle-follow

import {
  placeLimit,
  createExchange,
  envNum,
  maybeClaim,
  loadConfig,
  shutdown,
  activeMarkets,
  marketOnchain,
  isTradable,
  ensureCollateralAllowance,
  outcomeSymbols,
  quantize,
  assertProbability,
  clampProbability,
  type EcContext,
  type UnifiedMarket,
} from "@dreamdex-bot-kit/ec-core";
import {
  SpotHistory,
  coinbaseSpotReader,
  estimateUp,
  marketBoundUp,
  marketImpliedUp,
  referenceReader,
  sdkSpotReader,
  type Asset,
  type ReferenceReader,
  type SpotReader,
} from "./signal.js";
import { paceReader, writePulse, type PaceReading } from "./volume-pace.js";
import { Positions } from "./position.js";
import {
  logDecision,
  logCycleSummary,
  backfillSettlements,
  computeStats,
} from "./journal.js";
import { postSignal } from "./telegram.js";
import { withTimeout } from "./timeout.js";
import { notifyCopyService } from "./copy-signal.js";
import { recordOrderBook, writeOrderBookSnapshot } from "./orderbook-cache.js";

const INTERVAL_MS = envNum("OF_INTERVAL_MS", 8_000);
const WINDOW_MS = envNum("OF_MOMENTUM_WINDOW_MS", 60_000);
const THRESHOLD = Number(process.env.OF_MOMENTUM_THRESHOLD ?? 0.0005); // 5 bps
const SENSITIVITY = envNum("OF_SENSITIVITY", 20);
// Fallback only: the bot MEASURES realized volatility from its own spot history
// and uses this until it has enough samples. This is the number the strike
// model's confidence hangs on, which is why it is no longer a constant.
const EXPECTED_MOVE = Number(process.env.OF_EXPECTED_MOVE ?? 0.0015);
// Floor under measured volatility. A stalled feed measures as zero movement, and
// zero volatility means the model is certain — the one direction this must not
// be allowed to fail in.
const MIN_VOL = Number(process.env.OF_MIN_VOL ?? 0.0002);
// How much spot history to retain for that measurement.
const VOL_WINDOW_MS = envNum("OF_VOL_WINDOW_MS", 600_000);
const EDGE = Number(process.env.OF_EDGE ?? 0.03);
// The ceiling to EDGE's floor. Cross when the market is a little cheaper than
// the model — not when it's wildly cheaper, because at that point the more
// likely explanation is that the model is wrong and the market knows something
// it doesn't. Set to 0 or less to disable.
const MAX_DISAGREEMENT = Number(process.env.OF_MAX_DISAGREEMENT ?? 0.1);
const MIN_MARKET_PRICE = Number(process.env.OF_MIN_MARKET_PRICE ?? 0.35);
const MAX_SHARES = envNum("OF_MAX_SHARES", 777);
const MAX_EXPOSURE = envNum("OF_MAX_EXPOSURE", 7770);
const COOLDOWN_MS = envNum("OF_COOLDOWN_MS", 30_000);
const FILL_RETRY_INTERVAL_MS = envNum("OF_FILL_RETRY_INTERVAL_MS", 3_000);
const FILL_RETRY_WINDOW_MS = envNum("OF_FILL_RETRY_WINDOW_MS", 60_000);

// Stop taking this long before expiry. The venue can lock between your snapshot
// and your send, and a late IOC then looks like filled=0 with no error (SDK
// gotcha #2), so some headroom is wanted.
//
// It has to SCALE WITH THE WINDOW. A flat 300s is right for mainnet's 15m and 1h
// series but swallows a 5m window whole, and testnet runs 5m and 10m today —
// there a fixed stop means the bot never trades at all, which is worse than
// trading carefully. 40% of the window, floored at 30s, capped at 300s.
// OF_NEAR_EXPIRY_STOP_MS overrides it with a fixed value when you want one.
const NEAR_EXPIRY_STOP_OVERRIDE_MS = process.env.OF_NEAR_EXPIRY_STOP_MS
  ? Number(process.env.OF_NEAR_EXPIRY_STOP_MS)
  : null;
// For social posts and the journal — "15m", "1h" etc, not parsed back out.
const windowLabel = (intervalSec: number | null): string => {
  if (!intervalSec || intervalSec <= 0) return "?";
  if (intervalSec % 3600 === 0) return `${intervalSec / 3600}h`;
  return `${Math.round(intervalSec / 60)}m`;
};

// Cross-asset confirmation: only execute once BOTH BTC and ETH have
// independently cleared every gate above within the same rolling window —
// a signal that never gets a same-window partner is effectively discarded
// (it just keeps failing this gate on every subsequent cycle until its own
// edge disappears or the market goes near-expiry). Asset-level, not
// market-specific: BTC/ETH each roll through many back-to-back 15m windows,
// and what this is checking is "is the underlying showing a real move on
// both legs right now," not any one specific pair of markets.
//
// NOTE: this confirms on EITHER asset qualifying, regardless of direction
// (BTC UP + ETH DOWN within the window still confirms). If you want to
// require the same direction on both legs, change the `confirmed` check
// below to also compare recorded signal direction.
const CROSS_ASSET_CONFIRM_ENABLED =
  (process.env.OF_CROSS_ASSET_CONFIRM ?? "true") !== "false";
const CROSS_ASSET_CONFIRM_MS = envNum("OF_CROSS_ASSET_CONFIRM_MS", 300_000);
const lastQualifyingSignal = new Map<Asset, number>();
const partnerAsset = (a: Asset): Asset => (a === "BTC" ? "ETH" : "BTC");

// lastQualifyingSignal above only proves both assets' SIGNALS cleared every
// gate near the same time — it says nothing about whether either order
// actually filled. A partner order can still revert on-chain after this
// gate passes (see incident notes), leaving one asset holding a naked
// directional position the gate was supposed to prevent. These two track
// the fill side of that: lastConfirmedFill records when an asset's order
// actually filled; unpairedLegs holds any fill still waiting on its
// partner to also fill within the window.
const lastConfirmedFill = new Map<Asset, number>();
const unpairedLegs = new Map<
  Asset,
  { symbol: string; size: number; since: number; alerted: boolean }
>();
const PARTNER_FILL_GRACE_MS = envNum(
  "OF_PARTNER_FILL_GRACE_MS",
  CROSS_ASSET_CONFIRM_MS
);

// A signal that qualifies but has no live partner yet is HELD here rather
// than discarded, so that when the partner confirms later, both sides
// trade — not just the second one to arrive. Keyed by asset; overwritten
// by a fresher qualifying signal for the same asset, consumed (deleted) by
// either side once a pairing fires.
interface PendingConfirmation {
  since: number;
  direction: "UP" | "DOWN";
  fire: (opts?: { skipEdgeCheck?: boolean }) => Promise<void>;
}

const pendingConfirmation = new Map<Asset, PendingConfirmation>();
// Most recent pace read, so a held (cross-asset) trade can re-check delta at
// execution time instead of trusting the reading from when it first qualified.
let latestPace: Map<Asset, PaceReading | null> = new Map();

// Which window lengths this bot is allowed to trade, in minutes. Comma-
// separated, e.g. "15,60". Defaults to 15-minute ONLY, because that's the
// only window the EMA(3,12) signal was ever backtested/validated against
// (180 days BTC, walk-forward validated: 56.8% test win rate, p=0.00033).
// activeMarkets() returns every tradable window DreamDEX offers with no
// filter of its own — without this, the bot silently applies an unvalidated
// signal to 4h/24h markets it was never tested on. Widen this only after
// backtesting those windows separately; don't assume the 15m result transfers.
const ALLOWED_WINDOW_MIN = (process.env.OF_ALLOWED_WINDOWS_MIN ?? "15")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

function windowAllowed(intervalSec: number | null): boolean {
  if (ALLOWED_WINDOW_MIN.length === 0) return true; // explicitly set empty = no filter
  if (!intervalSec) return false; // unknown window length — don't trade it by default
  const mins = intervalSec / 60;
  return ALLOWED_WINDOW_MIN.includes(mins);
}

// Wall-clock trading schedule, independent of anything market-related. Unlike
// OF_ALLOWED_WINDOWS_MIN (which windows/expiries are tradable), this is when
// the BOT ITSELF is allowed to scan and fire at all — a full pause of new
// entries, not a per-market filter.
//
// Two independent pieces, both in UTC to avoid DST/local-timezone drift on a
// server that isn't necessarily in your timezone:
//   1. A single CONTINUOUS weekly window, e.g. "Monday 12:00 -> Friday 08:00" —
//      this is NOT the same as picking a set of days and a same-clock-time
//      range on each (the old model): the start day/time and end day/time can
//      differ, and the window runs through every hour in between, including
//      overnight. Modeled as minute-of-week so Mon 23:50 -> Tue 00:10 just
//      works without special-casing midnight.
//   2. An optional DAILY pause carved out of that window every day it's
//      active (e.g. a 08:30-09:30 settlement pause) — checked independently
//      of the weekly window, so it applies inside it correctly regardless of
//      where the weekly window's own boundaries fall.
//
// Disabled by default — always-on unless explicitly turned on.
const TRADING_HOURS_ENABLED =
  (process.env.OF_TRADING_HOURS_ENABLED ?? "false") === "true";

// "DOW-HH:MM", ISO weekday 1=Mon..7=Sun. e.g. "1-12:00" = Monday noon.
function parseDayTime(
  s: string,
  fallback: string
): { dow: number; min: number } {
  const [dowStr, hhmm] = (s || fallback).split("-");
  const dow = Number(dowStr);
  const [h, m] = (hhmm ?? "00:00").split(":").map(Number);
  return {
    dow: Number.isFinite(dow) && dow >= 1 && dow <= 7 ? dow : 1,
    min: (h || 0) * 60 + (m || 0),
  };
}
const WEEKLY_START = parseDayTime(
  process.env.OF_TRADING_WEEK_START ?? "",
  "1-00:00"
);
const WEEKLY_END = parseDayTime(
  process.env.OF_TRADING_WEEK_END ?? "",
  "7-23:59"
);

function minuteOfWeek(dow: number, min: number): number {
  return (dow - 1) * 1440 + min; // 0 = Monday 00:00
}
const WEEK_START_MOW = minuteOfWeek(WEEKLY_START.dow, WEEKLY_START.min);
const WEEK_END_MOW = minuteOfWeek(WEEKLY_END.dow, WEEKLY_END.min);

function parseHHMM(s: string): number | null {
  if (!s) return null;
  const [h, m] = s.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}
// Optional daily carve-out, e.g. "08:30" / "09:30". Both must be set to apply.
const DAILY_PAUSE_START_MIN = parseHHMM(
  process.env.OF_TRADING_DAILY_PAUSE_START_UTC ?? ""
);
const DAILY_PAUSE_END_MIN = parseHHMM(
  process.env.OF_TRADING_DAILY_PAUSE_END_UTC ?? ""
);
const DAILY_PAUSE_ENABLED =
  DAILY_PAUSE_START_MIN !== null && DAILY_PAUSE_END_MIN !== null;

function withinTradingWindow(now: Date): boolean {
  if (!TRADING_HOURS_ENABLED) return true;

  const isoWeekday = ((now.getUTCDay() + 6) % 7) + 1; // JS 0=Sun -> ISO 1=Mon..7=Sun
  const dayMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const mow = minuteOfWeek(isoWeekday, dayMin);

  const inWeeklyWindow =
    WEEK_START_MOW <= WEEK_END_MOW
      ? mow >= WEEK_START_MOW && mow < WEEK_END_MOW
      : mow >= WEEK_START_MOW || mow < WEEK_END_MOW; // wraps past end of week (Sun->Mon)
  if (!inWeeklyWindow) return false;

  if (DAILY_PAUSE_ENABLED) {
    const inPause =
      DAILY_PAUSE_START_MIN! <= DAILY_PAUSE_END_MIN!
        ? dayMin >= DAILY_PAUSE_START_MIN! && dayMin < DAILY_PAUSE_END_MIN!
        : dayMin >= DAILY_PAUSE_START_MIN! || dayMin < DAILY_PAUSE_END_MIN!;
    if (inPause) return false;
  }

  return true;
}

// Temporary risk lever: pause new bearish (BUY_NO) entries entirely while
// leaving bullish (BUY_YES) trading untouched. this only blocks NEW entries.
const DISABLE_DOWN = (process.env.OF_DISABLE_DOWN ?? "false") === "true";

// Backtested/validated: EMA(3,12) momentum vs a flat market, walk-forward
// validated (56.8% test win rate, p=0.00033).
// Default true so real funds only ride the validated signal; set to "false"
// to let the (unvalidated) strike-only trades through again.
const REQUIRE_MOMENTUM =
  (process.env.OF_REQUIRE_MOMENTUM ?? "true") !== "false";

// Require momentum to be backed by above-baseline volume before it counts.
// Same "measure, don't assume" philosophy as MIN_VOL — a stalled/thin feed
// should not silently pass as confirmed. Default OFF.
const REQUIRE_VOLUME_CONFIRM =
  (process.env.OF_REQUIRE_VOLUME_CONFIRM ?? "false") === "true";
const VOLUME_RATIO_MIN = Number(process.env.OF_VOLUME_RATIO_MIN ?? 1.3);
// Order-flow delta confirmation (net taker buy - sell, Binance-only — see
// volume-pace.ts). Total volume answers "did activity happen"; this answers
// "was it pushing the direction the signal is calling." Independent gate,
// same fail-open philosophy: unavailable/insufficient data => treated as
// confirmed, never as a reason to block a trade by itself.
const REQUIRE_DELTA_CONFIRM =
  (process.env.OF_REQUIRE_DELTA_CONFIRM ?? "false") === "true";
const DELTA_RATIO_MIN = Number(process.env.OF_DELTA_RATIO_MIN ?? 1.3);
// Bucket size for the volume pace curve. 900_000 = 15 min matches DreamDEX's
// own :00/:15/:30/:45 market grid exactly. Must be a whole number of minutes.
const VOLUME_CANDLE_MS = envNum("OF_VOLUME_CANDLE_MS", 900_000);
// Empirical pace curve (see volume-pace.ts): the forming bucket's cumulative
// volume after k closed minutes vs the MEDIAN cumulative volume after the same
// k minutes across the last N closed buckets.
const PACE_BASELINE_BUCKETS = envNum("OF_PACE_BASELINE_BUCKETS", 8);
const PACE_MIN_BASELINE_BUCKETS = envNum("OF_PACE_MIN_BASELINE_BUCKETS", 4);
// Don't judge pace before this many CLOSED minutes of the window have elapsed.
const PACE_MIN_ELAPSED_MIN = envNum("OF_PACE_MIN_ELAPSED_MIN", 2);
// A minute only counts as closed this long after it ends (lets the last bar finalize).
const PACE_SETTLE_MS = envNum("OF_PACE_SETTLE_MS", 2_000);
// Snapshot the dashboard polls. Relative to cwd (next to index.html), and
// deliberately NOT under logs/, which checkpoint.sh commits to GitHub.
const PULSE_PATH = process.env.PULSE_PATH ?? "volume-pulse.json";
// Same pattern, for the copy service's book-depth polling — see
// orderbook-cache.ts. Also relative to cwd, also outside logs/.
const ORDERBOOK_SNAPSHOT_PATH =
  process.env.ORDERBOOK_SNAPSHOT_PATH ?? "orderbook-snapshot.json";
// How many book levels to keep in that snapshot. The bot's own trading only
// ever looks at asks[0] — this is free depth for copiers walking the book,
// not something any trading gate depends on.
const BOOK_DEPTH = envNum("OF_BOOK_DEPTH", 15);

const nearExpiryStopMs = (intervalSec: number | null): number =>
  NEAR_EXPIRY_STOP_OVERRIDE_MS ??
  (intervalSec && intervalSec > 0
    ? Math.max(30_000, Math.min(300_000, intervalSec * 1000 * 0.4))
    : 300_000);
// The momentum term's horizon has to match the contract's. A 60-second return
// says almost nothing about a market resolving in eight hours — extrapolated
// over 495 windows it becomes a claimed +3.97% drift, which is noise wearing a
// probability's clothes. Past this many lookback windows the momentum TERM is
// muted; the market itself is still priced, because moneyness against a known
// reference works at any horizon. Default 30 windows = 30 min at the 60s
// default. 0 disables the gate entirely.
const MAX_HORIZONS = envNum("OF_MAX_HORIZONS", 30);
// The feed ticks ~1/s. Anything older than this means the oracle stalled, and a
// frozen price reads as "no momentum" rather than "no data" — refuse it.
const MAX_SPOT_AGE_MS = envNum("OF_MAX_SPOT_AGE_MS", 15_000);
const MODEL =
  (process.env.OF_MODEL ?? "strike") === "momentum" ? "momentum" : "strike";
// Which momentum computation feeds the drift term: the original single-window
// return ("window"), or the EMA(fast)/EMA(slow) crossover validated in the
// Python backtest ("ema", default — see signal.ts's SpotHistory.emaMomentum).
// Falling back to "window" is a one-line env change if the live behavior
// needs comparing against the original.
const MOMENTUM_SOURCE =
  (process.env.OF_MOMENTUM_SOURCE ?? "ema") === "window" ? "window" : "ema";
const EMA_FAST_SPAN = envNum("OF_EMA_FAST_SPAN", 3);
const EMA_SLOW_SPAN = envNum("OF_EMA_SLOW_SPAN", 12);
const SPOT_SOURCE = (process.env.OF_SPOT_SOURCE ?? "sdk").toLowerCase();

let spot: SpotReader;
// Most cycles end in "no edge", which is silent. Without a heartbeat the bot
// looks hung when it's working correctly, so summarise what it saw.
const HEARTBEAT_MS = envNum("OF_HEARTBEAT_MS", 30_000);

const ASSETS: readonly Asset[] = ["BTC", "ETH"];
const isAsset = (a: string): a is Asset =>
  (ASSETS as readonly string[]).includes(a);

// Interruptible sleep — wakes within ~500ms of the stop flag (see ec-maker).
const sleep = async (ms: number, stopped?: () => boolean) => {
  for (let t = 0; t < ms; t += 500) {
    if (stopped?.()) return;
    await new Promise((r) => setTimeout(r, Math.min(500, ms - t)));
  }
};
const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);

// Retention is set by the volatility estimate, not by momentum: measuring how
// much the underlying moves needs far more samples than one lookback window.
const history = new SpotHistory(
  WINDOW_MS,
  MAX_SPOT_AGE_MS,
  VOL_WINDOW_MS,
  EMA_FAST_SPAN,
  EMA_SLOW_SPAN
);
// Empirical volume pace for the volume gate AND the dashboard's MARKET PULSE
// card: 1-minute bars from Binance + Coinbase (summed), aggregated into our own
// buckets. The gate fails open if a read errors or history is too short.
const pace = paceReader({
  bucketMs: VOLUME_CANDLE_MS,
  baselineBuckets: PACE_BASELINE_BUCKETS,
  minBaselineBuckets: PACE_MIN_BASELINE_BUCKETS,
  minElapsedMin: PACE_MIN_ELAPSED_MIN,
  settleMs: PACE_SETTLE_MS,
});
// Per-market state keyed by SYMBOL — never by pool address, which v2 recycles
// across successive markets.
const position = new Positions();
const lastTake = new Map<string, number>();
const warned = new Set<string>();
// Expiry per symbol we hold a position in, recorded the moment we take it.
// position.clear() is normally driven by seeing isTradable()===false for a
// market still returned by activeMarkets() — but once a market fully
// settles, activeMarkets() may stop returning it at all, so takeOne() never
// runs for that symbol again and clear() never fires. That leaves its
// shares/exposure locked against MAX_SHARES/MAX_EXPOSURE forever, which is
// exactly what produces a hard stop once totalNet() hits MAX_EXPOSURE (e.g.
// 10 trades at MAX_SHARES=5 with MAX_EXPOSURE=50). sweepExpiredPositions()
// below is a second, independent path to clear() that doesn't depend on
// activeMarkets() still mentioning the symbol at all.
const positionExpiry = new Map<string, number>();
// Markets currently failing settlement backfill, keyed by market_id (not
// symbol — a symbol can be reused across successive markets, a market_id
// can't). Populated/cleared from backfillSettlements()'s result each
// heartbeat. sweepExpiredPositions() consults this before releasing
// exposure for a symbol, so a market that's failing to confirm on-chain
// doesn't silently free its risk budget on a timer.
const settlementFailures = new Map<
  string,
  { symbol: string; error: string; since: number }
>();
// Grace period past expiry before we assume a market has settled and release
// its exposure — gives on-chain settlement time to actually land so we don't
// clear a position that's still technically pending.
const EXPIRY_CLEAR_GRACE_MS = envNum("OF_EXPIRY_CLEAR_GRACE_MS", 10 * 60_000);
// Guards against multiple fills in the SAME market window. Without this,
// COOLDOWN_MS + a generous MAX_SHARES/MAX_EXPOSURE combination lets the bot
// re-enter a market it already traded every time cooldown clears, pyramiding
// into one view rather than diversifying across markets. Cleared in the same
// two places position/positionExpiry are (market goes untradable, or the
// grace-period sweep after expiry) — never left to grow unbounded.
const enteredMarkets = new Set<string>();

// Release any unpairedLegs flag whose symbol just cleared, from whichever
// path cleared it (expiry sweep or isTradable()===false) — so a resolved
// naked position doesn't keep blocking new entries for that asset forever.
function clearUnpairedLeg(symbol: string): void {
  for (const [asset, leg] of unpairedLegs) {
    if (leg.symbol === symbol) unpairedLegs.delete(asset);
  }
}

function sweepExpiredPositions(now: number): void {
  for (const [symbol, expiryMs] of positionExpiry) {
    if (now - expiryMs >= EXPIRY_CLEAR_GRACE_MS) {
      position.clear(symbol);
      positionExpiry.delete(symbol);
      lastTake.delete(symbol);
      enteredMarkets.delete(symbol);
      clearUnpairedLeg(symbol);
    }
  }
}

// Alert (once) on any leg that's been waiting past PARTNER_FILL_GRACE_MS
// with no confirmed partner fill — this is the case a chain-level revert on
// the other leg produces: the gate passed, this leg filled, the partner
// never did. It stays in unpairedLegs (blocking new entries on that asset)
// until the position itself clears via clearUnpairedLeg above.
function sweepUnpairedLegs(now: number): void {
  for (const [asset, leg] of unpairedLegs) {
    if (!leg.alerted && now - leg.since >= PARTNER_FILL_GRACE_MS) {
      leg.alerted = true;
      log(
        `🚨 CROSS-ASSET PAIR FAILED: ${asset} ${leg.symbol} filled ${leg.size} ` +
          `shares with no ${partnerAsset(asset)} partner fill within ` +
          `${(PARTNER_FILL_GRACE_MS / 60_000).toFixed(
            1
          )}min — likely a reverted ` +
          `partner order. This is naked directional exposure the cross-asset ` +
          `gate was meant to prevent. New ${asset} entries stay blocked until ` +
          `this position settles.`
      );
    }
  }
}

/** What one cycle saw, so a quiet bot can still show its work. */
interface Cycle {
  scanned: number;
  skips: Map<string, number>;
  /** The market that came closest to triggering, for the heartbeat line. */
  best?: {
    symbol: string;
    pUp: number;
    tilt: number;
    fair: number;
    ask: number;
    short: number;
    /** Where the settlement level came from, so a wrong fair value is traceable. */
    ref: string;
    /** Volatility the fair value was scaled by, and whether it was measured. */
    vol: string;
  };
  /** The worst model-vs-market gap seen, so a muzzled bot says why. */
  widest?: { symbol: string; model: number; market: number; by: number };
}
const newCycle = (): Cycle => ({ scanned: 0, skips: new Map() });
const note = (c: Cycle, reason: string) =>
  c.skips.set(reason, (c.skips.get(reason) ?? 0) + 1);

/** Binary-market fields the signal needs. Non-binary rows return null. */
function marketInfo(m: UnifiedMarket): {
  asset: string;
  strike?: string;
  marketId?: string;
  expiryMs: number | null;
  intervalSec: number | null;
} | null {
  if (m.info.marketType !== "BINARY") return null;
  const expiry = Number(m.info.expiry); // unix SECONDS as a string on the row
  const interval = Number(m.info.intervalSec);
  return {
    asset: m.info.asset,
    strike: m.info.strike,
    marketId: m.info.marketId,
    expiryMs: Number.isFinite(expiry) && expiry > 0 ? expiry * 1000 : null,
    intervalSec: Number.isFinite(interval) && interval > 0 ? interval : null,
  };
}

// Trade one underlying only, or leave it blank for whatever the venue runs.
// The other EC bots honour this; keeping it uniform so a config that says BTC
// means BTC everywhere.
const UNDERLYING = (process.env.EC_UNDERLYING ?? "").toUpperCase();
function isNoFillError(e: Error): boolean {
  const msg = e.message ?? "";
  return /ImmediateOrCancelNoFill|InsufficientLiquidity|FillOrKillNotFillable/i.test(
    msg
  );
}

async function takeOne(
  ctx: EcContext,
  spot: SpotReader,
  refs: ReferenceReader,
  market: UnifiedMarket,
  cycle: Cycle,
  paceCache: Map<Asset, PaceReading | null>
): Promise<void> {
  if (UNDERLYING && !market.symbol.toUpperCase().includes(UNDERLYING)) return;
  // 1) Authoritative status. The indexer lags; only this snapshot decides.
  const onchain = await marketOnchain(ctx, market);
  if (!onchain) return;
  // DreamDEX/Somnia's own market explorer - https://dev.smk.somnia.host/markets/{pool}
  // (prd.smk on mainnet)
  const marketContract = onchain.marketAddress ?? onchain.marketAddress ?? null;
  const explorerUrl = marketContract
    ? `${ctx.config.indexerUrl.replace(
        /\/v1\/graphql$/,
        ""
      )}/markets/${marketContract}`
    : null;
  if (!isTradable(onchain)) {
    position.clear(market.symbol);
    positionExpiry.delete(market.symbol);
    lastTake.delete(market.symbol);
    enteredMarkets.delete(market.symbol);
    warned.delete(`opp:${market.symbol}`);
    clearUnpairedLeg(market.symbol);
    note(cycle, "not trading");
    return;
  }
  cycle.scanned++;

  const info = marketInfo(market);
  if (!info) return;
  if (!windowAllowed(info.intervalSec)) {
    note(cycle, "window not in OF_ALLOWED_WINDOWS_MIN");
    return;
  }

  // Warm the allowance for this pool during scanning, decoupled from the
  // price-sensitive send path in fire(). Idempotent/cached per pool. the point is to absorb the
  // block-confirmation delay several cycles before a signal ever fires,
  // instead of it landing between reading the ask and crossing it.
  ensureCollateralAllowance(
    ctx,
    onchain,
    10n ** BigInt(ctx.config.decimals)
  ).catch((e: Error) =>
    log(`${market.symbol}: allowance warmup failed: ${(e as Error).message}`)
  );
  if (!isAsset(info.asset)) {
    if (!warned.has(info.asset)) {
      warned.add(info.asset);
      log(
        `skipping ${info.asset} markets — no price feed wired for that asset`
      );
    }
    note(cycle, "unknown asset");
    return;
  }
  // Hoisted once the asset is known to be a valid Asset — used by both the
  // cross-asset confirm gate (signal-level) and the fill-reconciliation
  // block after a successful take (fill-level).
  const thisAsset = info.asset as Asset;

  const now = Date.now();

  // 2) Soft stop before expiry. As price converges to 0 or 1 a late entry is a
  // coin flip, and the window can lock mid-order. The on-chain status gate is
  // the hard cutoff at lock; this is the earlier guard the operator controls.
  const stopMs = nearExpiryStopMs(info.intervalSec);
  if (info.expiryMs !== null && info.expiryMs - now < stopMs) {
    note(cycle, "near expiry");
    return;
  }

  // 3) Sample the underlying and measure the short-window return.
  const observed = await spot.getSpot(info.asset);
  if (observed) history.record(info.asset, observed);
  const mom =
    MOMENTUM_SOURCE === "ema"
      ? history.emaMomentum(info.asset, now)
      : history.momentum(info.asset, now);
  if (!mom) {
    if (!warned.has(`warm:${info.asset}`)) {
      warned.add(`warm:${info.asset}`);
      log(`warming up spot history for ${info.asset}`);
    }
    note(cycle, "warming up");
    return;
  }
  warned.delete(`warm:${info.asset}`);

  // 4) What does this market actually settle against? A fixed strike wears it in
  // the symbol; an up/down market carries `strike = 0` and settles against its
  // own OPENING price, one indexer call away. With that level in hand the market
  // is priceable from the oracle alone — how far spot sits from the reference,
  // over how long, against how much the underlying actually moves.
  const ttl = info.expiryMs === null ? null : info.expiryMs - now;
  const ref = await refs.referenceFor(
    { marketId: info.marketId, strike: info.strike },
    mom.spot
  );

  // 5) Momentum is only admissible when its horizon is near the contract's. A
  // 60-second return says nothing about eight hours, so past MAX_HORIZONS it is
  // dropped — but that mutes the momentum TERM rather than vetoing the market,
  // because moneyness against a known reference prices any horizon honestly.
  const horizonOk =
    MAX_HORIZONS <= 0 || (ttl !== null && ttl <= MAX_HORIZONS * WINDOW_MS);
  // Below the threshold the return is feed noise, not a view.
  const useMomentum = horizonOk && Math.abs(mom.r) >= THRESHOLD;

  // 5b) Volume confirmation — empirical pace curve. Cumulative volume over the
  // first k closed minutes of THIS window vs the median cumulative volume over
  // the same first k minutes of the last N closed windows (volume-pace.ts).
  // No waiting for the candle to close, no assumption volume is evenly spread.
  // Mutes the momentum TERM when unconfirmed; does not veto the market.
  //
  // volumeConfirmed stays null when the gate didn't run at all.
  let volumeConfirmed: boolean | null = null;
  let volumeRatio: number | null = null;
  let paceEarly = false;
  let deltaRatioOut: number | null = null;
  let deltaBlocked = false;
  // Raw delta, read regardless of whether momentum/volume gates ran, so the
  // direction check below can always compare it to the actual trade side.
  const deltaRatioRaw: number | null =
    paceCache.get(thisAsset)?.deltaRatio ?? null;
  if (REQUIRE_VOLUME_CONFIRM && useMomentum) {
    const reading = paceCache.get(thisAsset) ?? null;
    volumeConfirmed = true; // fail OPEN if no reading / baseline still warming
    if (reading === null) {
      if (!warned.has(`vol:${info.asset}`)) {
        warned.add(`vol:${info.asset}`);
        log(`volume pace has no data for ${info.asset} — volume confirmation failing open`);
      }
    } else {
      warned.delete(`vol:${info.asset}`);
      if (reading.state === "too_early") {
        // Baseline exists but too little of this window has traded to judge.
        // Not confirmed — set to true instead to fail open here too.
        volumeConfirmed = false;
        paceEarly = true;
      } else if (reading.state === "ok" && reading.ratio !== null) {
        volumeRatio = reading.ratio;
        volumeConfirmed = volumeRatio >= VOLUME_RATIO_MIN;

        // Delta confirmation runs only once total volume already passed —
        // it's a stricter follow-up check, not an alternative path. A move
        // can be volume-confirmed but delta-unconfirmed (two-sided churn:
        // heavy buying AND selling, netting near zero) — that's exactly the
        // pattern this is meant to catch that a raw volume ratio can't.
        if (volumeConfirmed && REQUIRE_DELTA_CONFIRM) {
          if (!reading.deltaAvailable || reading.deltaRatio === null) {
            // Binance down, or delta baseline still warming — fail open,
            // same treatment as an unavailable volume reading.
          } else {
            const bullishSignal = mom.r > 0;
            const deltaAgrees = bullishSignal
              ? reading.deltaRatio > 0
              : reading.deltaRatio < 0;
            deltaRatioOut = reading.deltaRatio;
            volumeConfirmed = deltaAgrees && Math.abs(reading.deltaRatio) >= DELTA_RATIO_MIN;
            deltaBlocked = !volumeConfirmed;
          }
        }
      }
      // state === "warming": stays true (fail open)
    }
  }
  // Not a fresh boolean gate on top of useMomentum — this is what "useMomentum"
  // actually gets to mean downstream. useMomentum itself is left unchanged
  // everywhere else (horizon math, the "why" log's "muted" branch, etc.): it
  // still means "the return cleared THRESHOLD," a distinct, useful fact from
  // "and it was volume-confirmed."
  const useMomentumConfirmed = useMomentum && (volumeConfirmed ?? true);

  if (!ref && !useMomentum) {
    note(
      cycle,
      horizonOk
        ? "no view and no reference price"
        : "no reference, and expiry too far out for momentum"
    );
    return;
  }

  // 6) Volatility, measured rather than assumed. This one number sets how
  // confident the model is allowed to be; a hardcoded guess had it pricing a
  // market the book held at 0.87 as 0.61. Floor it, because a stalled feed
  // measures as zero volatility and zero volatility means total certainty.
  const measured = history.volatility(info.asset);
  const expectedMove = Math.max(measured ?? EXPECTED_MOVE, MIN_VOL);

  // 7) The market's own view: the anchor the relative model builds on, and the
  // sanity check the absolute one is measured against. The YES mid is P(up) in
  // market terms.
  const { yes, no } = outcomeSymbols(market);
  const yesBook = await ctx.exchange.fetchOrderBook(yes, BOOK_DEPTH);
  recordOrderBook(yes, yesBook);
  let anchorUp = marketImpliedUp(yesBook);

  if (anchorUp === null) {
    // A one-sided book has no mid. Momentum mode needs a mid and refuses; strike
    // mode with a resolved reference uses `marketBoundUp` for disagreement checks.
    if (!ref) {
      note(cycle, "no two-sided market to price against");
      return;
    }
    anchorUp = marketBoundUp(yesBook);
    if (anchorUp === null) {
      note(cycle, "empty book");
      return;
    }
  }

  const { pUp, tilt } = estimateUp({
    spot: mom.spot,
    r: useMomentumConfirmed ? mom.r : 0,
    strike: ref?.price ?? null,
    timeToExpiryMs: ttl,
    windowMs: WINDOW_MS,
    expectedMove,
    sensitivity: SENSITIVITY,
    model: MODEL,
    anchorUp,
  });

  // 8) Pick the leg the MARKET underprices — the sign of the disagreement, not
  // of the view. A bullish tilt makes YES cheap, a bearish one makes NO cheap,
  // and a bearish tilt buys NO rather than selling YES: a sell escrows the token
  // sold, so there is no naked short here.
  if (tilt === 0) {
    note(cycle, "no disagreement with market");
    return;
  }
  const bullish = tilt > 0;

  // Direction agreement: the leg we're about to buy must match the momentum
  // sign AND the order-flow delta sign. The gates above validate momentum in
  // isolation; this validates the actual TRADE (tilt is driven mostly by
  // moneyness vs the reference, which can point the other way).
  const tradeSign = bullish ? 1 : -1;
  if (REQUIRE_MOMENTUM && Math.sign(mom.r) !== tradeSign) {
    note(cycle, "momentum opposes trade direction");
    return;
  }
  if (REQUIRE_DELTA_CONFIRM && deltaRatioRaw !== null) {
    const deltaAgrees = bullish
      ? deltaRatioRaw >= DELTA_RATIO_MIN
      : deltaRatioRaw <= -DELTA_RATIO_MIN;
    if (!deltaAgrees) {
      note(cycle, "order-flow delta doesn't confirm trade direction");
      return;
    }
  }

  if (!bullish && DISABLE_DOWN) {
    note(cycle, "DOWN trades disabled (OF_DISABLE_DOWN)");
    return;
  }
  const fav = bullish ? yes : no;

  // Never buy the leg opposite one we already hold. That doesn't reverse the
  // position, it mints complete sets: the two legs cancel, the collateral stays
  // locked until expiry, and we paid a spread on each side for the privilege.
  // Selling what we hold is strictly better — on a 0.755/0.775 book, dumping a
  // YES returns 0.753 now against a set that redeems for ~0.99 at expiry — but
  // this bot has no sell path, so the honest move is to stop rather than to
  // spend spread going nowhere. It will sit this market out until expiry.
  const leg = bullish ? "yes" : "no";
  const opposing = position.opposing(market.symbol, leg);
  if (opposing > 0) {
    if (!warned.has(`opp:${market.symbol}`)) {
      warned.add(`opp:${market.symbol}`);
      log(
        `${market.symbol}: signal favours ${
          bullish ? "YES" : "NO"
        } but we hold ${opposing} ` +
          `${
            bullish ? "NO" : "YES"
          } — sitting out (buying the other leg would only mint sets)`
      );
    }
    note(cycle, "holding the opposing leg");
    return;
  }
  // One entry per market, period — regardless of remaining MAX_SHARES/
  // MAX_EXPOSURE headroom. A market that already has a fill from us doesn't
  // get a second one; the signal firing again on the same window isn't a
  // second independent view, it's the same view re-confirming itself.
  if (enteredMarkets.has(market.symbol)) {
    note(cycle, "already entered this market");
    return;
  }
  // On this venue a leg's price IS its probability in human units, and the
  // unified layer already reports the NO book in NO terms. So the fair price is
  // the probability itself — do NOT run it through `probabilityToPrice`, which
  // is the raw-layer converter and returns scaled bigints.
  const fairFav = bullish ? pUp : 1 - pUp;
  const marketFair = bullish ? anchorUp : 1 - anchorUp;

  // 8b) Refuse trades where the market itself already prices the favoured
  // leg below MIN_MARKET_PRICE. This is a floor on marketFair, not on the
  // edge or the model's fairFav — a wide edge at a low market price is
  // exactly the shape a mispriced fair-value estimate takes.
  if (MIN_MARKET_PRICE > 0 && marketFair < MIN_MARKET_PRICE) {
    note(cycle, "market price below floor");
    return;
  }

  // 9) Sanity-check the model against the market before believing it. When the
  // model lands far from the market's mid, treat it as a bug rather than a
  // bonanza: a 25-cent "edge" almost always means the model can't see something
  // the market can (an unreadable strike, a question it doesn't understand), not
  // that the market mispriced by 25 cents. Together with EDGE this makes a band
  // — cross when the market is cheaper than the model by a little, refuse when
  // it's cheaper by a lot. For the momentum model the gap is the tilt; for the
  // strike model it is |fair − market|.
  const disagreement = Math.abs(fairFav - marketFair);
  if (MAX_DISAGREEMENT > 0 && disagreement > MAX_DISAGREEMENT) {
    if (!cycle.widest || disagreement > cycle.widest.by) {
      cycle.widest = {
        symbol: fav,
        model: fairFav,
        market: marketFair,
        by: disagreement,
      };
    }
    note(cycle, "model disagrees with market");
    return;
  }

  if (REQUIRE_MOMENTUM && !useMomentumConfirmed) {
    note(
      cycle,
      paceEarly
        ? "volume pace: too early in window"
        : deltaBlocked
        ? "momentum unconfirmed by order-flow delta (OF_REQUIRE_DELTA_CONFIRM)"
        : volumeConfirmed === false
        ? "momentum unconfirmed by volume (OF_REQUIRE_VOLUME_CONFIRM)"
        : "no momentum contribution (OF_REQUIRE_MOMENTUM)"
    );
    return;
  }

  // 10) A view is not a trade: only cross when the ask is below fair by EDGE.
  // Crossing costs about half the spread, so on a 2-cent book a 2-cent tilt
  // cannot pay for itself — this is the gate that says so.
  const favBook = bullish ? yesBook : await ctx.exchange.fetchOrderBook(fav, BOOK_DEPTH);
  if (!bullish) recordOrderBook(fav, favBook); // bullish case: fav===yes, already recorded above
  const top = favBook.asks[0];
  if (!top) {
    note(cycle, "empty ask side");
    return;
  }
  const [askPx, askAmt] = top;

  // 9b) EDGE alone doesn't account for WHERE on the probability scale the
  // edge sits. A 3-cent edge at ask=0.85 clears the same EDGE threshold as a
  // 3-cent edge at ask=0.50, but the breakeven win rate is completely
  // different: buying at price p needs win_rate > p to profit, since price
  // IS probability on this venue. Observed live: 77.8% win rate, avg entry
  // ~0.82, net LOSS
  const MAX_ENTRY_PRICE = Number(process.env.OF_MAX_ENTRY_PRICE ?? 0.7);
  if (askPx > MAX_ENTRY_PRICE) {
    note(
      cycle,
      `entry too rich (ask ${askPx.toFixed(
        2
      )} > OF_MAX_ENTRY_PRICE ${MAX_ENTRY_PRICE})`
    );
    return;
  }

  const short = askPx - (fairFav - EDGE); // how far the ask is from triggering
  if (short > 0) {
    if (!cycle.best || short < cycle.best.short) {
      cycle.best = {
        symbol: fav,
        pUp,
        tilt,
        fair: fairFav,
        ask: askPx,
        short,
        ref: ref ? `${ref.kind} ${ref.price.toFixed(2)}` : "none",
        vol: `${(expectedMove * 100).toFixed(3)}%${
          measured === null ? " assumed" : ""
        }`,
      };
    }
    note(cycle, "no edge");
    return;
  }

  // 11) Risk limits, counted in DIRECTIONAL shares. The opposing-leg guard above
  // means one leg is always zero here, so the net is what we hold in `fav` — but
  // derive it rather than assume, so the limits stay honest if that guard ever
  // softens into a sell.
  const net = position.net(market.symbol);
  if (net >= MAX_SHARES) {
    note(cycle, "at max shares");
    return;
  }
  const exposure = position.totalNet();
  if (exposure >= MAX_EXPOSURE) {
    note(cycle, "at max exposure");
    return;
  }
  if (now - (lastTake.get(market.symbol) ?? 0) < COOLDOWN_MS) {
    note(cycle, "cooling down");
    return;
  }

  const budget = Math.min(askAmt, MAX_SHARES - net, MAX_EXPOSURE - exposure);
  const size = quantize(ctx, budget); // venue lot grid
  if (size <= 0) {
    note(cycle, "below one lot");
    return;
  }

  // This signal has cleared every trading gate. Everything that actually
  // sends the order and records it is wrapped in `fire()` so it can be
  // invoked either right away (cross-asset confirm disabled, or this
  // signal is the one that completes a pairing) or later, when a partner
  // signal on the other asset confirms it (see the gate below).
  const fire = async (
    opts: { skipEdgeCheck?: boolean } = {}
  ): Promise<void> => {
    // Re-check the near-expiry stop at execution time: this closure may run
    // significantly later than when it was captured, if it sat waiting on a
    // cross-asset partner.
    if (
      info.expiryMs !== null &&
      info.expiryMs - Date.now() < nearExpiryStopMs(info.intervalSec)
    ) {
      log(
        `${market.symbol}: held cross-asset trade dropped — expiry approaching`
      );
      return;
    }

    // askPx/favBook were captured when this signal first qualified. Cross-asset
    // confirmation can hold this closure for up to CROSS_ASSET_CONFIRM_MS before
    // it runs — long enough for the book to have moved past that snapshot
    // entirely. Re-fetch and re-check the edge right before sending rather than
    // trusting a stale ask. Cheap to run unconditionally: on the immediate
    // (non-held) path no time has passed, so this almost always just confirms
    // what we already had.
    // Re-check delta at execution time: this closure may have been held for
    // minutes waiting on the cross-asset partner.
    if (REQUIRE_DELTA_CONFIRM) {
      const d = latestPace.get(thisAsset)?.deltaRatio ?? null;
      if (d !== null && (bullish ? d < DELTA_RATIO_MIN : d > -DELTA_RATIO_MIN)) {
        log(
          `${market.symbol}: held trade dropped — delta no longer confirms ` +
            `${bullish ? "UP" : "DOWN"} (${d.toFixed(2)}x)`
        );
        return;
      }
    }

    const side = bullish ? "BUY_YES" : "BUY_NO";
    const whyPrefix =
      `${
        ref
          ? `${ref.kind} ${ref.price.toFixed(2)} vs spot ${mom.spot.toFixed(2)}`
          : "no reference"
      }, ` +
      `vol ${(expectedMove * 100).toFixed(3)}%${
        measured === null ? " assumed" : " measured"
      }, ` +
      `r ${
        useMomentum ? `${mom.r >= 0 ? "+" : ""}${mom.r.toFixed(4)}` : "muted"
      }, ` +
      `volConfirm ${
        volumeConfirmed === null
          ? "n/a"
          : `${volumeConfirmed}${
              volumeRatio !== null ? ` (${volumeRatio.toFixed(2)}x)` : ""
            }${deltaRatioRaw !== null ? `, delta ${deltaRatioRaw.toFixed(2)}x` : ""}`
      }, ` +
      `tilt ${tilt >= 0 ? "+" : ""}${tilt.toFixed(
        3
      )} off market ${marketFair.toFixed(3)}, ` +
      `pUp ${pUp.toFixed(3)}, fair ${fairFav.toFixed(3)}`;

    // How long a no-fill leg keeps retrying, capped so it never runs past
    // the market's own near-expiry stop.
    const retryDeadline = Math.min(
      Date.now() + FILL_RETRY_WINDOW_MS,
      info.expiryMs !== null
        ? info.expiryMs - nearExpiryStopMs(info.intervalSec)
        : Date.now() + FILL_RETRY_WINDOW_MS
    );

    let taken = 0;
    let price = 0;
    let filledAskPx = 0;

    if (ctx.config.dryRun) {
      const book = await ctx.exchange.fetchOrderBook(fav, BOOK_DEPTH);
      recordOrderBook(fav, book);
      const top = book.asks[0];
      if (!top) {
        log(`${market.symbol}: dry-run skipped — ${fav} book empty`);
        return;
      }
      filledAskPx = top[0];
      price = clampProbability(
        ctx.exchange.priceToPrecision(fav, filledAskPx + 0.002)
      );
      assertProbability(price);
      taken = size;
      log(
        `DRY ${side} ${size} ${fav} @ ~${price.toFixed(
          3
        )} (${whyPrefix}, ask ${filledAskPx.toFixed(3)})`
      );
    } else {
      while (true) {
        const book = await ctx.exchange.fetchOrderBook(fav, BOOK_DEPTH);
        recordOrderBook(fav, book);  
        const top = book.asks[0];
        if (!top) {
          log(`${market.symbol}: retry stopped — ${fav} book now empty`);
          break;
        }
        const [askPx] = top;

        if (!opts.skipEdgeCheck && askPx > fairFav - EDGE) {
          log(
            `${market.symbol}: retry stopped — edge gone (ask ${askPx.toFixed(
              3
            )}, ` +
              `fair ${fairFav.toFixed(3)}, needed ≤ ${(fairFav - EDGE).toFixed(
                3
              )})`
          );
          break;
        }

        const attemptPrice = clampProbability(
          ctx.exchange.priceToPrecision(fav, askPx + 0.002)
        );
        assertProbability(attemptPrice);

        try {
          const order = await placeLimit(ctx, {
            market,
            onchain,
            outcome: bullish ? "YES" : "NO",
            side: "buy",
            price: attemptPrice,
            size,
            type: "ioc",
          });
          taken = order.filled;
          log(
            `${side} ${taken}/${size} ${fav} @ ~${attemptPrice.toFixed(
              3
            )} (${whyPrefix}, ask ${askPx.toFixed(3)})`
          );
          if (taken > 0) {
            price = attemptPrice;
            filledAskPx = askPx;
            break;
          }
        } catch (e) {
          if (!isNoFillError(e as Error)) throw e;
          log(
            `${market.symbol}: no fill (${
              (e as Error).message
            }), retrying in ${FILL_RETRY_INTERVAL_MS}ms...`
          );
        }

        if (Date.now() + FILL_RETRY_INTERVAL_MS >= retryDeadline) {
          log(`${market.symbol}: retry window exhausted with no fill`);
          break;
        }
        await new Promise((r) => setTimeout(r, FILL_RETRY_INTERVAL_MS));
      }

      if (taken <= 0) return;
    }

    const why = `${whyPrefix}, ask ${filledAskPx.toFixed(3)}`;

    // Reconcile against the partner's actual FILL, not its signal. This
    // fill just landed — check whether the partner asset also has a fill
    // recorded within the confirm window. If so, both legs are genuinely
    // paired and any prior unpaired flags on either asset are cleared. If
    // not, this is the naked-leg case (the gate passed on signals, but the
    // partner's order never actually filled — e.g. it reverted on-chain): flag
    // this asset as carrying an unpaired leg so new entries on it are blocked
    // (via the unpairedLegs.has() check above) until the position resolves.
    if (CROSS_ASSET_CONFIRM_ENABLED) {
      const other = partnerAsset(thisAsset);
      const partnerFilledRecently =
        (lastConfirmedFill.get(other) ?? 0) >=
        Date.now() - CROSS_ASSET_CONFIRM_MS;
      lastConfirmedFill.set(thisAsset, Date.now());
      if (partnerFilledRecently) {
        unpairedLegs.delete(thisAsset);
        unpairedLegs.delete(other);
      } else {
        unpairedLegs.set(thisAsset, {
          symbol: market.symbol,
          size: taken,
          since: Date.now(),
          alerted: false,
        });
        log(
          `⚠️ ${thisAsset} filled ${taken} ${fav} without a confirmed ${other} ` +
            `partner fill — flagged unpaired, new ${thisAsset} entries blocked ` +
            `until this position resolves`
        );
      }
    }

    // Book the fill against the LEG we bought, in BOTH modes. A dry run that
    // ignored its own cooldown and exposure caps would re-take the same market
    // every cycle and tell you nothing about how the limits behave — which is most
    // of what you want to see before handing it a funded key.
    position.add(market.symbol, leg, taken);
    lastTake.set(market.symbol, Date.now());
    enteredMarkets.add(market.symbol);
    if (info.expiryMs !== null)
      positionExpiry.set(market.symbol, info.expiryMs);

    logDecision({
      market_id: info.marketId!, // guaranteed by this point: a tradable BINARY market that passed marketInfo() and isTradable() above
      symbol: market.symbol,
      asset: info.asset,
      window: windowLabel(info.intervalSec),
      side,
      size: taken,
      price,
      dry_run: ctx.config.dryRun,
      signal: bullish ? "UP" : "DOWN",
      fair_prob: fairFav,
      market_mid: marketFair,
      edge: fairFav - filledAskPx,
      disagreement,
      momentum_r: useMomentum ? mom.r : null,
      momentum_used: useMomentum,
      volume_confirmed: volumeConfirmed,
      volume_ratio: volumeRatio,
      delta_ratio: deltaRatioRaw,
      reason: why,
      expiry_ms: info.expiryMs,
      ref_price: ref?.price ?? null,
      ref_kind: ref?.kind ?? null,
      explorer_url: explorerUrl,
    });

    // Calculate a price ceiling that sweeps deeper order book levels for copiers
    const COPY_SLIPPAGE_BUFFER = Number(
      process.env.OF_COPY_SLIPPAGE_BUFFER ?? 0.15
    );
    const MAX_COPY_PRICE = Number(process.env.OF_COPY_MAX_PRICE ?? 0.99);

    const copierLimitPrice = Math.min(
      MAX_COPY_PRICE,
      Number((filledAskPx * (1 + COPY_SLIPPAGE_BUFFER)).toFixed(4))
    );

    const marketId = info.marketId ?? onchain.pool;

    // Notify the copy-trade service right after the journal write
    const OUTCOME_TOKEN = "0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9";

    const binaryInfo =
      market.info.marketType === "BINARY"
        ? (market.info as { yesTokenId?: string; noTokenId?: string })
        : null;

    const yesId =
      binaryInfo?.yesTokenId != null ? String(binaryInfo.yesTokenId) : "";
    const noId =
      binaryInfo?.noTokenId != null ? String(binaryInfo.noTokenId) : "";

    // Dry-run never fires the copy service: there's no real fill behind it,
    // so copiers must not be signaled to trade off a paper position. This is
    // a hard skip (the call isn't made at all), not just a dryRun:true flag
    // in the payload — the copy service should never even see a dry-run
    // signal.
    if (ctx.config.dryRun) {
      log(`${market.symbol}: skip copy notify — dry run`);
    } else if (!yesId || !noId) {
      log(
        `${market.symbol}: skip copy notify — missing yesTokenId/noTokenId on market.info`
      );
    } else {
      writeOrderBookSnapshot(ORDERBOOK_SNAPSHOT_PATH);
      notifyCopyService({
        id: `sig_${marketId}_${Date.now()}`,
        marketId: marketId,
        symbol: market.symbol,
        asset: info.asset,
        window: windowLabel(info.intervalSec),
        side: bullish ? "BUY_YES" : "BUY_NO",
        price: filledAskPx,
        limitPrice: copierLimitPrice,
        pool: onchain.pool,
        expiryMs: info.expiryMs,
        dryRun: ctx.config.dryRun,
        timestamp: Date.now(),
        outcomeToken: OUTCOME_TOKEN,
        yesId,
        noId,
        venueSymbol: fav, 
      });
    }

    // Post to Telegram AFTER the journal write so a signal always shows up in
    // the dashboard even if the Telegram call fails or isn't configured — then
    // log a second decision record with the message_id attached, so the last-
    // write-wins read pattern (see journal.ts) picks it up for settlement edits
    // without needing a distinct "update" record type.
    const messageId = await postSignal({
      marketId: info.marketId!,
      symbol: market.symbol,
      asset: info.asset,
      window: windowLabel(info.intervalSec),
      signal: bullish ? "UP" : "DOWN",
      edge: fairFav - filledAskPx,
      disagreement,
      momentumUsed: useMomentum,
      volumeConfirmed,
      volumeRatio,
      deltaRatio: deltaRatioOut,
      expiryMs: info.expiryMs,
      dryRun: ctx.config.dryRun,
      entryPrice: price,
      size: taken,
      refPrice: ref?.price ?? null,
      refKind: ref?.kind ?? null,
      explorerUrl,
      stats: computeStats(),
    }).catch((e) => {
      console.error(`telegram post failed: ${(e as Error).message}`);
      return null;
    });

    if (messageId) {
      logDecision({
        market_id: info.marketId!,
        symbol: market.symbol,
        asset: info.asset,
        window: windowLabel(info.intervalSec),
        side,
        size: taken,
        price,
        dry_run: ctx.config.dryRun,
        signal: bullish ? "UP" : "DOWN",
        fair_prob: fairFav,
        market_mid: marketFair,
        edge: fairFav - filledAskPx,
        disagreement,
        momentum_r: useMomentum ? mom.r : null,
        momentum_used: useMomentum,
        volume_confirmed: volumeConfirmed,
        volume_ratio: volumeRatio,
        delta_ratio: deltaRatioRaw,
        reason: why,
        expiry_ms: info.expiryMs,
        ref_price: ref?.price ?? null,
        ref_kind: ref?.kind ?? null,
        explorer_url: explorerUrl,
        telegram_message_id: messageId,
      });
    }
  };

  // 10b) Cross-asset confirmation. This signal just cleared every gate
  // above. If the OTHER asset already has a live, unconsumed qualifying
  // signal waiting, both trade now: the partner's held `fire()` runs first
  // (it qualified earlier), then this one's. Otherwise this signal is HELD
  // — not discarded — so that when the partner confirms later, both sides
  // actually trade rather than only the second one to arrive.
  //
  // A signal-level "confirmed" only proves both assets' SIGNALS lined up —
  // it says nothing about whether either order actually filled. If this
  // asset currently has an unresolved unpaired fill (its own order filled
  // earlier but the partner leg never confirmed — e.g. the partner's IOC
  // reverted on-chain after both sides passed this same gate), refuse new
  // entries on this asset until that position resolves. Otherwise the bot
  // just keeps compounding naked exposure on the same side.
  if (CROSS_ASSET_CONFIRM_ENABLED) {
    if (unpairedLegs.has(thisAsset)) {
      note(
        cycle,
        "asset has an unresolved unpaired leg — refusing to compound"
      );
      return;
    }

    const confirmNow = Date.now();
    const other = partnerAsset(thisAsset);
    const pendingOther = pendingConfirmation.get(other);
    const thisDirection: "UP" | "DOWN" = bullish ? "UP" : "DOWN";
    const otherFresh =
      pendingOther &&
      confirmNow - pendingOther.since <= CROSS_ASSET_CONFIRM_MS &&
      pendingOther.direction === thisDirection;

    if (pendingOther && !otherFresh) {
      // Partner exists but is either stale or pointing the other way —
      // a direction mismatch is not "no partner", it's a real disagreement,
      // worth its own skip reason rather than being lumped into the generic wait.
      const staleness =
        confirmNow - pendingOther.since > CROSS_ASSET_CONFIRM_MS;
      note(
        cycle,
        staleness
          ? "waiting for cross-asset confirmation"
          : "cross-asset signals disagree on direction"
      );
      pendingConfirmation.set(thisAsset, {
        since: confirmNow,
        direction: thisDirection,
        fire,
      });
      return;
    }

    if (!otherFresh) {
      // No live, unconsumed partner waiting — hold this one and stop.
      // Overwrites any stale/earlier entry for thisAsset: only the most
      // recent qualifying signal per asset should be live.
      pendingConfirmation.set(thisAsset, {
        since: confirmNow,
        direction: bullish ? "UP" : "DOWN",
        fire,
      });
      note(cycle, "waiting for cross-asset confirmation");
      return;
    }

    // Partner is live — confirmed. Consume both so neither can be reused to
    // vouch for a later, unrelated signal, then fire both trades CONCURRENTLY.
    // Concurrent firing bounds the gap between the two legs to roughly the
    // difference in their individual round-trip times instead of the sum.
    pendingConfirmation.delete(other);
    pendingConfirmation.delete(thisAsset);
    const results = await Promise.allSettled([
      pendingOther!.fire({ skipEdgeCheck: true }),
      fire({ skipEdgeCheck: true }),
    ]);
    for (const r of results) {
      if (r.status === "rejected") {
        log(`cross-asset fire failed: ${(r.reason as Error).message}`);
      }
    }
    return;
  }

  // Gate disabled — fire immediately as before.
  await fire();
}

// One pace read per asset per cycle, shared by every market's gate AND written
// to the dashboard snapshot. Runs regardless of REQUIRE_VOLUME_CONFIRM so the
// MARKET PULSE card keeps tracking even with the gate off.
async function refreshPace(): Promise<Map<Asset, PaceReading | null>> {
  const out = new Map<Asset, PaceReading | null>();
  const now = Date.now();
  await Promise.all(
    (["BTC", "ETH"] as Asset[]).map(async (a) => {
      try {
        out.set(a, await withTimeout(pace.getPace(a, now), 12_000, `pace(${a})`));
        warned.delete(`pace:${a}`);
      } catch (e) {
        out.set(a, null);
        if (!warned.has(`pace:${a}`)) {
          warned.add(`pace:${a}`);
          log(`volume pace read failed for ${a}: ${(e as Error).message} — gate failing open`);
        }
      }
    })
  );
  writePulse(PULSE_PATH, out, {
    gateEnabled: REQUIRE_VOLUME_CONFIRM,
    ratioMin: VOLUME_RATIO_MIN,
    bucketMin: VOLUME_CANDLE_MS / 60_000,
  });
  return out;
}

async function main() {
  const ctx = createExchange({ withSigner: !loadConfig().dryRun });

  if (SPOT_SOURCE === "binance" || process.env.NETWORK === "mainnet") {
    spot = coinbaseSpotReader();
    log(`using Coinbase REST spot reader (mainnet)`);
  } else if (SPOT_SOURCE === "sdk") {
    if (!ctx.config.priceFeed) {
      throw new Error(
        "No price feed configured — this bot needs the UNDERLYING price. " +
          "On mainnet set OF_SPOT_SOURCE=binance or wait for an official PRICE_FEED_URL."
      );
    }
    spot = sdkSpotReader(ctx);
  } else {
    throw new Error(
      `OF_SPOT_SOURCE="${SPOT_SOURCE}" is not wired. ` +
        `Supported values: "sdk" | "binance"`
    );
  }

  const refs = referenceReader(ctx);

  log(
    `oracle-follow up as ${
      ctx.exchange.walletAddress ?? "(no key, dry run)"
    } · dryRun=${ctx.config.dryRun} · ` +
      `model=${MODEL} interval=${INTERVAL_MS}ms window=${WINDOW_MS}ms edge=${EDGE} ` +
      `maxDisagreement=${MAX_DISAGREEMENT > 0 ? MAX_DISAGREEMENT : "off"} ` +
      `maxHorizons=${
        MAX_HORIZONS > 0
          ? `${MAX_HORIZONS} (${((MAX_HORIZONS * WINDOW_MS) / 60_000).toFixed(
              0
            )}min)`
          : "off"
      } ` +
      `crossAssetConfirm=${
        CROSS_ASSET_CONFIRM_ENABLED
          ? `${(CROSS_ASSET_CONFIRM_MS / 60_000).toFixed(1)}min`
          : "off"
      } ` +
            `allowedWindows=${
        ALLOWED_WINDOW_MIN.length
          ? ALLOWED_WINDOW_MIN.join(",") + "min"
          : "ALL (unfiltered!)"
      } ` +
      `volumeConfirm=${
        REQUIRE_VOLUME_CONFIRM
          ? `on (binance+coinbase 1m pace, bucket=${(
              VOLUME_CANDLE_MS / 60_000
            ).toFixed(0)}min, baseline=${PACE_BASELINE_BUCKETS} buckets, minElapsed=${PACE_MIN_ELAPSED_MIN}min, ratioMin=${VOLUME_RATIO_MIN}, deltaConfirm=${REQUIRE_DELTA_CONFIRM ? `on (ratioMin=${DELTA_RATIO_MIN})` : "off"})`
          : "off"
      } ` +
      `tradingHours=${
        TRADING_HOURS_ENABLED
          ? `${WEEKLY_START.dow}-${String(
              Math.floor(WEEKLY_START.min / 60)
            ).padStart(2, "0")}:${String(WEEKLY_START.min % 60).padStart(
              2,
              "0"
            )} -> ` +
            `${WEEKLY_END.dow}-${String(
              Math.floor(WEEKLY_END.min / 60)
            ).padStart(2, "0")}:${String(WEEKLY_END.min % 60).padStart(
              2,
              "0"
            )} UTC` +
            (DAILY_PAUSE_ENABLED
              ? ` (daily pause ${process.env.OF_TRADING_DAILY_PAUSE_START_UTC}-${process.env.OF_TRADING_DAILY_PAUSE_END_UTC})`
              : "")
          : "off (24/7)"
      }`
  );

  let stop = false;
  const requestStop = () => (stop = true);
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);

  let nextHeartbeat = Date.now() + HEARTBEAT_MS;
  while (!stop) {
    const cycle = newCycle();
    try {
      // Collect anything that settled since the last pass. Self-throttled
      // (AUTO_CLAIM_INTERVAL_MS) and a no-op under AUTO_CLAIM=false.
      await withTimeout(maybeClaim(ctx), 20_000, "maybeClaim");
      // Independent of whatever activeMarkets() returns this cycle — see the
      // comment on positionExpiry above for why this can't just rely on
      // isTradable() being seen again for a symbol that already settled.
      sweepExpiredPositions(Date.now());
      // Independent pass over unpairedLegs: alert once a naked leg has sat
      // unresolved past PARTNER_FILL_GRACE_MS. Runs on the same heartbeat
      // cadence as the expiry sweep above. Kept OUTSIDE the trading-window
      // gate below on purpose: an existing naked leg still needs its alert
      // even while the bot is paused from opening anything new.
      sweepUnpairedLegs(Date.now());

      // Wall-clock pause. Everything above this (maybeClaim, sweeps) is
      // cleanup for positions already taken, not new risk, so it keeps
      // running on schedule even while paused — only scanning/new entries
      // stop. Skipping activeMarkets() entirely (rather than fetching and
      // then discarding every market below) also means a paused bot makes
      // zero RPC/indexer calls for the scan itself, not just zero trades.
      // Before the trading-window check on purpose: the volume map keeps
      // tracking while the bot is paused.
      const paceCache = await refreshPace();
      latestPace = paceCache;

      if (!withinTradingWindow(new Date())) {
        note(cycle, "outside trading window (OF_TRADING_HOURS_ENABLED)");
      } else {
        const markets = await withTimeout(
          activeMarkets(ctx),
          20_000,
          "activeMarkets"
        );
 
        for (const m of markets) {
          if (stop) break;
          try {
            // Per-market, not just per-cycle: one market's stalled RPC/indexer
            // call must not freeze every other tradable market behind it for
            // the rest of this cycle (or, since the loop is sequential, forever
            // — see timeout.ts for why this can't be fixed inside the SDK itself).
            await withTimeout(
              takeOne(ctx, spot, refs, m, cycle, paceCache),
              20_000,
              `takeOne(${m.symbol})`
            );
          } catch (e) {
            log(`${m.symbol} error: ${(e as Error).message}`);
          }
        }
      }
      // After the scan, so this cycle's freshly-fetched books are what the
      // copy service polls next, not last cycle's.
      writeOrderBookSnapshot(ORDERBOOK_SNAPSHOT_PATH);
    } catch (e) {
      log(`cycle error: ${(e as Error).message}`);
    }
    if (stop) break;

    if (HEARTBEAT_MS > 0 && Date.now() >= nextHeartbeat) {
      nextHeartbeat = Date.now() + HEARTBEAT_MS;
      const reasons =
        [...cycle.skips].map(([r, n]) => `${r} ×${n}`).join(", ") || "none";
      const b = cycle.best;
      const closest = b
        ? ` · closest ${b.symbol} ref ${b.ref} vol ${b.vol} tilt ${
            b.tilt >= 0 ? "+" : ""
          }${b.tilt.toFixed(3)} fair ${b.fair.toFixed(3)} ask ${b.ask.toFixed(
            3
          )} (needs ${b.short.toFixed(3)} more)`
        : "";
      const w = cycle.widest;
      const gap = w
        ? ` · ${w.symbol} model ${w.model.toFixed(
            3
          )} vs market ${w.market.toFixed(3)} (off by ${w.by.toFixed(3)})`
        : "";
      // Report GROSS alongside net: if they ever diverge, the bot is holding
      // offsetting legs and the difference is capital locked in complete sets.
      const gross = position.totalGross();
      const netTotal = position.totalNet();
      const book =
        gross === 0
          ? "flat"
          : `net ${netTotal}${gross === netTotal ? "" : ` of ${gross} gross`}`;
      log(
        `idle · ${cycle.scanned} tradable · ${book} · ${reasons}${gap}${closest}`
      );

      logCycleSummary({
        scanned: cycle.scanned,
        skips: Object.fromEntries(cycle.skips),
      });

      // Backfill settlement outcomes for the dashboard, on the same throttle
      // as the heartbeat — this only reads chain state, it never redeems (that's
      // maybeClaim's job above), so it's safe to run in dry-run too.
      backfillSettlements(ctx)
        .then(({ failed }) => {
          const now = Date.now();
          for (const f of failed) {
            const prior = settlementFailures.get(f.marketId);
            settlementFailures.set(f.marketId, {
              symbol: f.symbol,
              error: f.error,
              since: prior?.since ?? now,
            });
          }
          // Drop anything that recovered (no longer reported as failing).
          for (const marketId of [...settlementFailures.keys()]) {
            if (!failed.some((f) => f.marketId === marketId))
              settlementFailures.delete(marketId);
          }
        })
        .catch((e) =>
          log(`settlement backfill failed: ${(e as Error).message}`)
        );
    }
    await sleep(INTERVAL_MS, () => stop);
  }

  // Nothing rests (IOC), so there is nothing to cancel on the way out.
  await shutdown(ctx);
  log("oracle-follow stopped");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
