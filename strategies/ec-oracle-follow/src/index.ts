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
  outcomeSymbols,
  quantize,
  assertProbability,
  clampProbability,
  type EcContext,
  type UnifiedMarket,
} from "@dreamdex-bot-kit/ec-core";
import {
  SpotHistory,
  estimateUp,
  marketBoundUp,
  marketImpliedUp,
  referenceReader,
  sdkSpotReader,
  type Asset,
  type ReferenceReader,
  type SpotReader,
} from "./signal.js";
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

// Backtested/validated: EMA(3,12) momentum vs a flat market, walk-forward
// validated (56.8% test win rate, p=0.00033). NOT backtested: the strike
// model's moneyness/disagreement logic on its own — that's DreamDEX's
// original placeholder-grade model, same category they flagged as unproven.
// Default true so real funds only ride the validated signal; set to "false"
// to let the (unvalidated) strike-only trades through again.
const REQUIRE_MOMENTUM =
  (process.env.OF_REQUIRE_MOMENTUM ?? "true") !== "false";

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

async function takeOne(
  ctx: EcContext,
  spot: SpotReader,
  refs: ReferenceReader,
  market: UnifiedMarket,
  cycle: Cycle
): Promise<void> {
  if (UNDERLYING && !market.symbol.toUpperCase().includes(UNDERLYING)) return;
  // 1) Authoritative status. The indexer lags; only this snapshot decides.
  const onchain = await marketOnchain(ctx, market);
  if (!onchain) return;
  // DreamDEX/Somnia's own market explorer, e.g. https://dev.smk.somnia.host/markets/{pool}
  // (prd.smk on mainnet) — host derived from ctx.config.indexerUrl so this
  // automatically matches testnet/mainnet rather than hardcoding one.
  // onchain.pool is the market's 20-byte contract address, NOT the same as
  // info.marketId (a 32-byte indexer-side identifier) — confirmed against
  // settlement.ts's own `address: onchain.pool` usage.
  const explorerUrl = onchain.pool
    ? `${ctx.config.indexerUrl.replace(/\/v1\/graphql$/, "")}/markets/${
        onchain.pool
      }`
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
  const yesBook = await ctx.exchange.fetchOrderBook(yes, 3);
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
    r: useMomentum ? mom.r : 0,
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

  if (REQUIRE_MOMENTUM && !useMomentum) {
    note(cycle, "no momentum contribution (OF_REQUIRE_MOMENTUM)");
    return;
  }

  // 10) A view is not a trade: only cross when the ask is below fair by EDGE.
  // Crossing costs about half the spread, so on a 2-cent book a 2-cent tilt
  // cannot pay for itself — this is the gate that says so.
  const favBook = bullish ? yesBook : await ctx.exchange.fetchOrderBook(fav, 3);
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

  // 10b) Cross-asset confirmation. This signal just cleared every gate
  // above — record it, then require the OTHER asset to have qualified
  // within the same rolling window before this one is allowed to fire.
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
    lastQualifyingSignal.set(thisAsset, confirmNow);
    const partnerLast = lastQualifyingSignal.get(partnerAsset(thisAsset));
    const confirmed =
      partnerLast !== undefined &&
      confirmNow - partnerLast <= CROSS_ASSET_CONFIRM_MS;
    if (!confirmed) {
      note(cycle, "waiting for cross-asset confirmation");
      return;
    }
  }

  // Cross a touch past the best so we still match if the book shifts, snapped
  // to the tick grid and the (0,1) bounds.
  const price = clampProbability(
    ctx.exchange.priceToPrecision(fav, askPx + 0.002)
  );
  assertProbability(price);

  const side = bullish ? "BUY_YES" : "BUY_NO";
  // Lead with the two inputs the fair value actually rests on — the level the
  // market settles against and the volatility scaling it — because when this bot
  // is wrong, it is almost always one of those two that was wrong first.
  const why =
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
    `tilt ${tilt >= 0 ? "+" : ""}${tilt.toFixed(
      3
    )} off market ${marketFair.toFixed(3)}, ` +
    `pUp ${pUp.toFixed(3)}, fair ${fairFav.toFixed(3)}, ask ${askPx.toFixed(
      3
    )}`;

  let taken = size;
  if (ctx.config.dryRun) {
    log(`DRY ${side} ${size} ${fav} @ ~${price.toFixed(3)} (${why})`);
  } else {
    // IOC: fill what crosses now, cancel the rest. A resting remainder would sit
    // there with its escrow locked (docs/event-contracts.md, sharp edge 2), and because nothing
    // rests there is nothing to cancel on shutdown.
    // placeLimit snaps the price to the tick grid as integers and checks the
    // receipt itself; handing the SDK a float price reverts outright on an
    // 18-decimal venue, and a revert reports zero fill rather than throwing.
    const order = await placeLimit(ctx, {
      market,
      onchain,
      outcome: bullish ? "YES" : "NO",
      side: "buy",
      price,
      size,
      type: "ioc",
    });
    // IOC cancels whatever didn't cross, so the requested size is an upper
    // bound, not the position. Count what actually filled.
    taken = order.filled;
    log(`${side} ${taken}/${size} ${fav} @ ~${price.toFixed(3)} (${why})`);
    if (taken <= 0) return; // nothing crossed; leave the cooldown clear to retry
  }

  // 10c) Reconcile against the partner's actual FILL, not its signal. This
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
      (lastConfirmedFill.get(other) ?? 0) >= now - CROSS_ASSET_CONFIRM_MS;
    lastConfirmedFill.set(thisAsset, now);
    if (partnerFilledRecently) {
      unpairedLegs.delete(thisAsset);
      unpairedLegs.delete(other);
    } else {
      unpairedLegs.set(thisAsset, {
        symbol: market.symbol,
        size: taken,
        since: now,
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
  lastTake.set(market.symbol, now);
  enteredMarkets.add(market.symbol);
  if (info.expiryMs !== null) positionExpiry.set(market.symbol, info.expiryMs);

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
    edge: fairFav - askPx,
    disagreement,
    momentum_r: useMomentum ? mom.r : null,
    momentum_used: useMomentum,
    reason: why,
    expiry_ms: info.expiryMs,
    ref_price: ref?.price ?? null,
    ref_kind: ref?.kind ?? null,
    explorer_url: explorerUrl,
  });

  // Notify the copy-trade service right after the journal write, same
  // reasoning as Telegram below — never blocks or depends on the bot's own
  // main loop, and never depends on Telegram's success/failure either.
  notifyCopyService({
    id: `${info.marketId}-${now}`,
    marketId: info.marketId!,
    symbol: market.symbol,
    asset: info.asset,
    window: windowLabel(info.intervalSec),
    side,
    price,
    pool: onchain.pool,
    expiryMs: info.expiryMs,
    dryRun: ctx.config.dryRun,
    timestamp: now,
  });

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
    edge: fairFav - askPx,
    disagreement,
    momentumUsed: useMomentum,
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
      edge: fairFav - askPx,
      disagreement,
      momentum_r: useMomentum ? mom.r : null,
      momentum_used: useMomentum,
      reason: why,
      expiry_ms: info.expiryMs,
      ref_price: ref?.price ?? null,
      ref_kind: ref?.kind ?? null,
      explorer_url: explorerUrl,
      telegram_message_id: messageId,
    });
  }
}

async function main() {
  // A signer is only needed to send orders. In DRY_RUN you can watch the bot
  // reason about live books and a live feed with no key at all.
  const ctx = createExchange({ withSigner: !loadConfig().dryRun });

  if (SPOT_SOURCE !== "sdk") {
    throw new Error(
      `OF_SPOT_SOURCE="${SPOT_SOURCE}" is not wired. The default "sdk" reads the ` +
        `underlying price feed; to use a REST ticker, build a restSpotReader in signal.ts.`
    );
  }
  if (!ctx.config.priceFeed) {
    throw new Error(
      "No price feed configured — this bot needs the UNDERLYING price, which no market row carries. " +
        "Set PRICE_FEED_URL in .env (testnet has a bundled default; mainnet does not yet)."
    );
  }
  const spot = sdkSpotReader(ctx);
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
      // cadence as the expiry sweep above.
      sweepUnpairedLegs(Date.now());
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
            takeOne(ctx, spot, refs, m, cycle),
            20_000,
            `takeOne(${m.symbol})`
          );
        } catch (e) {
          log(`${m.symbol} error: ${(e as Error).message}`);
        }
      }
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
