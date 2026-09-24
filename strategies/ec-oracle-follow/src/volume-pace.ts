/**
 * Empirical volume pace ("RVOL by minute") for the volume-confirmation gate,
 * plus the snapshot the dashboard's MARKET PULSE card reads.
 *
 * This is taken WHILE the window forms:
 *
 *   1. Pull 1-minute bars from Binance + Coinbase
 *   2. Aggregate them into our own buckets aligned to the epoch (15m buckets
 *      line up with DreamDEX's :00/:15/:30/:45 market grid).
 *   3. For the forming bucket, take cumulative volume over its first k CLOSED
 *      minutes.
 *   4. For each of the last N closed buckets, take cumulative volume over the
 *      same first k minutes. The MEDIAN of those is "what minute k usually
 *      looks like" — no assumption that volume is spread evenly.
 *   5. ratio = forming cumulative / baseline cumulative.
 *
 * Because the whole history is re-fetched every read (it is only ~150 bars),
 * the baseline needs no warm-up after a redeploy and can never be poisoned by
 * a venue outage: baseline and forming bucket always come from the same set
 * of venues in the same fetch.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Asset } from "./signal.js";

const MINUTE_MS = 60_000;

export interface Bar {
  t: number; // minute open time, ms
  o: number;
  c: number;
  v: number; // base-asset volume
  /** Taker BUY base-asset volume (Binance only — Coinbase's public candles
   *  endpoint has no buy/sell split). sellV = v - buyV. Undefined on bars
   *  from a venue that can't provide it. */
  buyV?: number;
}

export interface PaceConfig {
  /** Bucket size in ms. Must be a whole number of minutes (900_000 = 15m). */
  bucketMs: number;
  /** How many closed buckets form the baseline. */
  baselineBuckets: number;
  /** Fewer usable closed buckets than this => state "warming" (gate fails open). */
  minBaselineBuckets: number;
  /** Don't judge pace before this many CLOSED minutes have elapsed. */
  minElapsedMin: number;
  /** A minute only counts as closed this long after it ends, so the venues'
   *  last bar has time to finalize. */
  settleMs: number;
  /** How many of the most recent closed minutes count as "recent" vs "earlier"
   *  when checking for a flow reversal. */
  reversalRecentMin: number;
  /** Recent countermove must be at least this fraction of the earlier push's
   *  magnitude to flag as a reversal. */
  reversalRatioMin: number;
}

/**
 * ok        – ratio is valid, gate can judge it
 * too_early – fewer than minElapsedMin closed minutes so far
 * warming   – not enough closed buckets of history for a baseline
 */
export type PaceState = "ok" | "too_early" | "warming";

export interface PaceReading {
  asset: Asset;
  state: PaceState;
  bucketStart: number;
  bucketMin: number;
  /** Whole closed minutes counted in the comparison (k). */
  elapsedMin: number;
  cumVolume: number;
  baselineCum: number | null;
  ratio: number | null;
  sources: ("binance" | "coinbase")[];
  price: number;
  windowOpen: number | null;
  changeWindow: number | null; // fraction, e.g. 0.0012 = +0.12%
  change1h: number | null;
  /** Closed buckets used for the baseline, oldest -> newest; mins = per-minute volume. */
  rows: { start: number; mins: number[]; deltaMins: number[] }[];
  /** Per-minute volume of the forming bucket's k closed minutes. */
  forming: number[];
  /** Volume in minutes not yet counted (settling + in-progress). Display only. */
  partial: number;

  // --- Order-flow delta (net taker buy − sell), Binance-only ---------------
  // Total volume confirms activity happened; delta confirms it happened in
  // the direction the signal is calling. Binance-only because Coinbase's
  // public candles endpoint carries no buy/sell split — when Binance is
  // down, deltaAvailable is false and every delta field below is null/empty,
  // which the gate treats as "fail open," identical to volume's own warming
  // state.
  /** True when Binance contributed to this read (the only source for delta). */
  deltaAvailable: boolean;
  /** Signed net taker delta (buy − sell) over the forming bucket's first k
   *  closed minutes. Positive = net buying. 0 (not meaningful) when
   *  deltaAvailable is false. */
  cumDelta: number;
  /** Median |delta| at minute k across the last N closed Binance buckets —
   *  a magnitude baseline. Not sign-matched: it answers "how strong does
   *  delta usually get by now," not "which way did it usually go." */
  deltaBaselineAbs: number | null;
  /** cumDelta / deltaBaselineAbs, signed. Compare its SIGN to the trade
   *  direction and its magnitude to a threshold — both checks matter. */
  deltaRatio: number | null;
  /** Per-minute signed delta of the forming bucket's k closed minutes. */
  formingDelta: number[];
  /** Is the push behind cumDelta already being unwound in the most recent
   *  closed minute(s)? null when deltaAvailable is false or there aren't
   *  enough closed minutes yet to split into "earlier" vs "recent" halves —
   *  treat null as "warming up," same fail-open posture as the other gates. */
  reversal: ReversalReading | null;
}

export interface ReversalReading {
  /** True when the recent minutes oppose the earlier push AND clear reversalRatioMin. */
  flagged: boolean;
  /** |recentDelta| / |earlierDelta|. */
  ratio: number;
  recentDelta: number;
  earlierDelta: number;
  recentMin: number;
}

// ---------------------------------------------------------------------------
// Pure math (exported so it can be unit-tested with synthetic bars)
// ---------------------------------------------------------------------------

const sum = (a: number[]): number => a.reduce((s, x) => s + x, 0);

function median(a: number[]): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function computeFlowReversal(
  formingDelta: number[],
  recentMin: number,
  ratioMin: number
): ReversalReading | null {
  const k = formingDelta.length;
  // Fixed-size, ADJACENT comparison: last N minutes vs the N minutes
  // immediately before them. This lets this start judging
  // a balanced 1-vs-1 split as soon as k=2 (matching the earliest a trade
  // can fire once OF_PACE_MIN_ELAPSED_MIN's default of 2 is cleared) instead
  // of sitting at "n/a" until a full recentMin*2 minutes have closed, and it
  // grows toward the configured recentMin as more minutes close.
  const N = Math.min(recentMin, Math.floor(k / 2));
  if (N < 1) return null; // fewer than 2 closed minutes — can't split yet
  const recent = formingDelta.slice(k - N);
  const earlier = formingDelta.slice(k - N * 2, k - N);
  const recentDelta = sum(recent);
  const earlierDelta = sum(earlier);
  if (earlierDelta === 0) return null; // nothing to reverse against
  const opposite =
    Math.sign(recentDelta) !== 0 &&
    Math.sign(recentDelta) !== Math.sign(earlierDelta);
  const ratio = Math.abs(recentDelta) / Math.abs(earlierDelta);
  return {
    flagged: opposite && ratio >= ratioMin,
    ratio,
    recentDelta,
    earlierDelta,
    recentMin: N,
  };
}

export function computePace(
  asset: Asset,
  binance: Bar[] | null,
  coinbase: Bar[] | null,
  now: number,
  cfg: PaceConfig
): PaceReading | null {
  const bucketMin = Math.round(cfg.bucketMs / MINUTE_MS);
  const staleBefore = now - 3 * MINUTE_MS;

  // A venue only contributes if its newest bar is recent. A frozen feed is
  // treated as down rather than silently under-counting the forming bucket.
  const venues: { name: "binance" | "coinbase"; bars: Bar[] }[] = [];
  if (binance?.length && binance[binance.length - 1]!.t >= staleBefore) {
    venues.push({ name: "binance", bars: binance });
  }
  if (coinbase?.length && coinbase[coinbase.length - 1]!.t >= staleBefore) {
    venues.push({ name: "coinbase", bars: coinbase });
  }
  if (venues.length === 0) return null;

  // History is only trustworthy back to where EVERY contributing venue starts —
  // a bucket covered by one venue but not the other would read artificially low.
  const coverStart = Math.max(...venues.map((v) => v.bars[0]!.t));

  const vol = new Map<number, number>();
  for (const v of venues) {
    for (const b of v.bars) vol.set(b.t, (vol.get(b.t) ?? 0) + b.v);
  }
  // Missing minute => zero volume (Coinbase omits minutes with no trades).
  const at = (start: number, i: number): number =>
    vol.get(start + i * MINUTE_MS) ?? 0;

  // Binance-only volume + delta maps. Kept separate from the combined `vol`
  // map above on purpose: mixing a venue that has a buy/sell split with one
  // that doesn't would make delta's denominator inconsistent with its
  // numerator. Delta is scoped to whatever Binance alone saw.
  const binanceVenue = venues.find((v) => v.name === "binance") ?? null;
  const deltaAvailable = binanceVenue !== null;
  const bVol = new Map<number, number>();
  const bDelta = new Map<number, number>();
  if (binanceVenue) {
    for (const b of binanceVenue.bars) {
      bVol.set(b.t, b.v);
      // buyV is guaranteed finite by binanceBars()'s filter when present;
      // treat a genuinely missing value as "can't compute delta for this
      // minute" (0) rather than silently assuming it's all sell volume.
      const buy = b.buyV ?? b.v / 2;
      bDelta.set(b.t, 2 * buy - b.v); // buy - sell = buy - (v - buy)
    }
  }
  const bDeltaAt = (start: number, i: number): number => bDelta.get(start + i * MINUTE_MS) ?? 0;
  const binanceCoverStart = binanceVenue ? binanceVenue.bars[0]!.t : Infinity;

  const bucketStart = Math.floor(now / cfg.bucketMs) * cfg.bucketMs;
  const curMin = Math.floor((now - bucketStart) / MINUTE_MS); // minute in progress
  const k = Math.max(
    0,
    Math.min(
      bucketMin - 1,
      Math.floor((now - cfg.settleMs - bucketStart) / MINUTE_MS)
    )
  );

  const forming = Array.from({ length: k }, (_, i) => at(bucketStart, i));
  const cumVolume = sum(forming);
  let partial = 0;
  for (let i = k; i <= curMin; i++) partial += at(bucketStart, i);

  const formingDelta = deltaAvailable
    ? Array.from({ length: k }, (_, i) => bDeltaAt(bucketStart, i))
    : [];
  const cumDelta = sum(formingDelta);
  const reversal = deltaAvailable
    ? computeFlowReversal(formingDelta, cfg.reversalRecentMin, cfg.reversalRatioMin)
    : null;

  const rows: PaceReading["rows"] = [];
  for (let j = cfg.baselineBuckets; j >= 1; j--) {
    const start = bucketStart - j * cfg.bucketMs;
    if (start < coverStart) continue;
    const mins = Array.from({ length: bucketMin }, (_, i) => at(start, i));
    if (sum(mins) <= 0) continue; // a bucket with no data at all is a gap, not a quiet bucket
    const deltaMins =
      deltaAvailable && start >= binanceCoverStart
        ? Array.from({ length: bucketMin }, (_, i) => bDeltaAt(start, i))
        : [];
    rows.push({ start, mins, deltaMins });
  }

  // Delta baseline: median |delta| at minute k across rows that actually
  // have Binance-covered delta data. Deliberately NOT the same `rows` gate
  // used for the volume baseline — a bucket can be in-range for combined
  // volume (Coinbase covered it) but out-of-range for Binance-only delta,
  // so this is its own count against cfg.minBaselineBuckets.
  let deltaBaselineAbs: number | null = null;
  let deltaRatio: number | null = null;
  if (deltaAvailable) {
    const deltaRows = rows.filter((r) => r.deltaMins.length > 0);
    if (deltaRows.length >= cfg.minBaselineBuckets && k > 0) {
      deltaBaselineAbs = median(deltaRows.map((r) => Math.abs(sum(r.deltaMins.slice(0, k)))));
      if (deltaBaselineAbs > 0) deltaRatio = cumDelta / deltaBaselineAbs;
    }
  }

  let baselineCum: number | null = null;
  let ratio: number | null = null;
  let state: PaceState;
  if (rows.length < cfg.minBaselineBuckets) {
    state = "warming";
  } else {
    baselineCum = median(rows.map((r) => sum(r.mins.slice(0, k))));
    if (k < cfg.minElapsedMin) {
      state = "too_early";
    } else if (!(baselineCum > 0)) {
      state = "warming";
    } else {
      state = "ok";
      ratio = cumVolume / baselineCum;
    }
  }

  // Price read from Coinbase when available (that's the bot's own spot source
  // on mainnet), otherwise Binance.
  const pxBars = (venues.find((v) => v.name === "coinbase") ?? venues[0]!).bars;
  const last = pxBars[pxBars.length - 1]!;
  const byT = new Map(pxBars.map((b) => [b.t, b] as const));
  const windowOpen = byT.get(bucketStart)?.o ?? null;
  const hourAgo = byT.get(last.t - 60 * MINUTE_MS)?.o ?? null;

  return {
    asset,
    state,
    bucketStart,
    bucketMin,
    elapsedMin: k,
    cumVolume,
    baselineCum,
    ratio,
    sources: venues.map((v) => v.name),
    price: last.c,
    windowOpen,
    changeWindow: windowOpen ? last.c / windowOpen - 1 : null,
    change1h: hourAgo ? last.c / hourAgo - 1 : null,
    rows,
    forming,
    partial,
    deltaAvailable,
    cumDelta,
    deltaBaselineAbs,
    deltaRatio,
    formingDelta,
    reversal,
  };
}

// ---------------------------------------------------------------------------
// Fetchers (1-minute bars, oldest -> newest)
// ---------------------------------------------------------------------------

// Node's fetch has no default timeout — see timeout.ts. These carry their own.
async function fetchJson(url: string, timeoutMs = 8_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function binanceBars(asset: Asset, limit: number): Promise<Bar[]> {
  const symbol = asset === "BTC" ? "BTCUSDT" : "ETHUSDT";
  // Rows: [openTime, open, high, low, close, volume, closeTime, ...], oldest first.
  const rows = (await fetchJson(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=${limit}`
  )) as unknown[][];
  // Row layout: [openTime, open, high, low, close, volume, closeTime,
  // quoteVolume, trades, takerBuyBaseVolume, takerBuyQuoteVolume, ignore].
  return rows
    .map((r) => ({
      t: Number(r[0]),
      o: Number(r[1]),
      c: Number(r[4]),
      v: Number(r[5]),
      buyV: Number(r[9]),
    }))
    .filter((b) => Number.isFinite(b.t) && b.v >= 0 && b.c > 0 && Number.isFinite(b.buyV));
}

async function coinbaseBars(asset: Asset, sinceMs: number): Promise<Bar[]> {
  const symbol = asset === "BTC" ? "BTC-USD" : "ETH-USD";
  // Rows: [time(sec), low, high, open, close, volume], NEWEST first, max 300.
  // Minutes with no trades are omitted — computePace treats a gap as 0.
  const rows = (await fetchJson(
    `https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=60`
  )) as number[][];
  return rows
    .map((r) => ({ t: r[0]! * 1000, o: r[3]!, c: r[4]!, v: r[5]! }))
    .filter(
      (b) => Number.isFinite(b.t) && b.t >= sinceMs && b.v >= 0 && b.c > 0
    )
    .sort((a, b) => a.t - b.t);
}

export interface PaceReader {
  getPace(asset: Asset, now: number): Promise<PaceReading | null>;
}

export function paceReader(cfgIn: PaceConfig): PaceReader {
  if (cfgIn.bucketMs % MINUTE_MS !== 0 || cfgIn.bucketMs < MINUTE_MS) {
    throw new Error(
      `volume-pace: bucketMs must be a whole number of minutes, got ${cfgIn.bucketMs}`
    );
  }
  const bucketMin = cfgIn.bucketMs / MINUTE_MS;
  // Coinbase returns at most 300 one-minute bars, so cap the baseline to fit.
  const maxBuckets = Math.max(1, Math.floor(290 / bucketMin) - 2);
  const cfg: PaceConfig = {
    ...cfgIn,
    baselineBuckets: Math.max(1, Math.min(cfgIn.baselineBuckets, maxBuckets)),
  };
  // baseline buckets + the forming one + one bucket of slack at the far edge.
  const limit = (cfg.baselineBuckets + 2) * bucketMin;
  const warnedDown = new Set<string>();

  const track = (
    key: string,
    r: PromiseSettledResult<unknown>,
    name: string
  ) => {
    if (r.status === "rejected") {
      if (!warnedDown.has(key)) {
        warnedDown.add(key);
        console.error(
          `${name} 1m bars down: ${
            (r.reason as Error)?.message ?? r.reason
          } — pace continues on the other venue`
        );
      }
    } else {
      warnedDown.delete(key);
    }
  };

  return {
    async getPace(asset, now) {
      const sinceMs =
        Math.floor(now / MINUTE_MS) * MINUTE_MS - (limit - 1) * MINUTE_MS;
      const [b, c] = await Promise.allSettled([
        binanceBars(asset, limit),
        coinbaseBars(asset, sinceMs),
      ]);
      track(`binance:${asset}`, b, `binance ${asset}`);
      track(`coinbase:${asset}`, c, `coinbase ${asset}`);
      return computePace(
        asset,
        b.status === "fulfilled" ? b.value : null,
        c.status === "fulfilled" ? c.value : null,
        now,
        cfg
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Dashboard snapshot
// ---------------------------------------------------------------------------

const r3 = (n: number): number => Number(n.toFixed(3));

/**
 * Writes the latest readings to a small JSON file the dashboard polls. Written
 * to a temp file then renamed so the dashboard never reads a half-written file.
 * Never throws — a dashboard write must not interrupt trading.
 *
 * Deliberately NOT under logs/: checkpoint.sh commits logs/ to GitHub, and this
 * file changes every cycle.
 */
export function writePulse(
  path: string,
  readings: Map<Asset, PaceReading | null>,
  meta: { gateEnabled: boolean; ratioMin: number; bucketMin: number }
): void {
  try {
    const assets: Record<string, unknown> = {};
    for (const [asset, r] of readings) {
      if (!r) continue;
      assets[asset] = {
        price: r.price,
        window_open: r.windowOpen,
        change_window: r.changeWindow,
        change_1h: r.change1h,
        state: r.state,
        bucket_start: r.bucketStart,
        elapsed_min: r.elapsedMin,
        cum: r3(r.cumVolume),
        baseline_cum: r.baselineCum === null ? null : r3(r.baselineCum),
        ratio: r.ratio === null ? null : r3(r.ratio),
        sources: r.sources,
        rows: r.rows.map((x) => ({
          start: x.start,
          mins: x.mins.map(r3),
          delta_mins: x.deltaMins.map(r3),
        })),
        forming: r.forming.map(r3),
        partial: r3(r.partial),
        delta_available: r.deltaAvailable,
        cum_delta: r3(r.cumDelta),
        delta_baseline_abs: r.deltaBaselineAbs === null ? null : r3(r.deltaBaselineAbs),
        delta_ratio: r.deltaRatio === null ? null : r3(r.deltaRatio),
        forming_delta: r.formingDelta.map(r3),
        reversal: r.reversal
          ? {
              flagged: r.reversal.flagged,
              ratio: r3(r.reversal.ratio),
              recent_delta: r3(r.reversal.recentDelta),
              earlier_delta: r3(r.reversal.earlierDelta),
              recent_min: r.reversal.recentMin,
            }
          : null,
      };
    }
    const payload = {
      updated_at: new Date().toISOString(),
      gate_enabled: meta.gateEnabled,
      ratio_min: meta.ratioMin,
      bucket_min: meta.bucketMin,
      assets,
    };
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload));
    renameSync(tmp, path);
  } catch (e) {
    console.error(`pulse snapshot write failed: ${(e as Error).message}`);
  }
}
