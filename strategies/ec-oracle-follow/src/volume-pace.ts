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
  rows: { start: number; mins: number[] }[];
  /** Per-minute volume of the forming bucket's k closed minutes. */
  forming: number[];
  /** Volume in minutes not yet counted (settling + in-progress). Display only. */
  partial: number;
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

  const rows: PaceReading["rows"] = [];
  for (let j = cfg.baselineBuckets; j >= 1; j--) {
    const start = bucketStart - j * cfg.bucketMs;
    if (start < coverStart) continue;
    const mins = Array.from({ length: bucketMin }, (_, i) => at(start, i));
    if (sum(mins) <= 0) continue; // a bucket with no data at all is a gap, not a quiet bucket
    rows.push({ start, mins });
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
  return rows
    .map((r) => ({
      t: Number(r[0]),
      o: Number(r[1]),
      c: Number(r[4]),
      v: Number(r[5]),
    }))
    .filter((b) => Number.isFinite(b.t) && b.v >= 0 && b.c > 0);
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
    .filter((b) => Number.isFinite(b.t) && b.t >= sinceMs && b.v >= 0 && b.c > 0)
    .sort((a, b) => a.t - b.t);
}

export interface PaceReader {
  getPace(asset: Asset, now: number): Promise<PaceReading | null>;
}

export function paceReader(cfgIn: PaceConfig): PaceReader {
  if (cfgIn.bucketMs % MINUTE_MS !== 0 || cfgIn.bucketMs < MINUTE_MS) {
    throw new Error(`volume-pace: bucketMs must be a whole number of minutes, got ${cfgIn.bucketMs}`);
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

  const track = (key: string, r: PromiseSettledResult<unknown>, name: string) => {
    if (r.status === "rejected") {
      if (!warnedDown.has(key)) {
        warnedDown.add(key);
        console.error(
          `${name} 1m bars down: ${(r.reason as Error)?.message ?? r.reason} — pace continues on the other venue`
        );
      }
    } else {
      warnedDown.delete(key);
    }
  };

  return {
    async getPace(asset, now) {
      const sinceMs = Math.floor(now / MINUTE_MS) * MINUTE_MS - (limit - 1) * MINUTE_MS;
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
        rows: r.rows.map((x) => ({ start: x.start, mins: x.mins.map(r3) })),
        forming: r.forming.map(r3),
        partial: r3(r.partial),
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
