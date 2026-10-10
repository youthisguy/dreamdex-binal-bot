/**
 * Forced-flow context: Binance liquidation pressure + open-interest change.
 * Shadow-logged into the decision journal by default; optionally usable as a
 * pre-entry veto (OF_REQUIRE_TRAP_CHECK, default OFF — see evaluateTrap()).
 *
 * Why this exists: the volume and delta gates confirm a move is REAL, but a
 * liquidation cascade is also a real, high-volume, delta-confirmed move. It is
 * forced flow, and it tends to reverse once the forced sellers (or squeezed
 * shorts) are exhausted. Volume and delta can't tell the two apart; these two
 * readings can:
 *
 *   - Liquidations: USD force-closed in the last few minutes on the side that
 *     PUSHES price in our trade direction (longs for a DOWN call, shorts for an
 *     UP call), as a multiple of that side's own recent baseline.
 *   - Open interest: OI falling while price runs our way means positions are
 *     being closed/liquidated (flush, reversal-prone); OI rising means new
 *     positions are opening (more durable).
 *
 * Sources (both free, Binance USD-M futures):
 *   Liquidations  wss .../market/ws/!forceOrder@arr. Binance pushes only the
 *                 LATEST liquidation per symbol per 1000ms, so in a heavy
 *                 cascade this UNDER-counts. Treat USD as a floor.
 *   Open interest GET /fapi/v1/openInterest, polled and ring-buffered here.
 *
 * Fail-open everywhere: a dead feed yields null readings, never an exception,
 * and nothing the trading loop awaits.
 */
import { WebSocket, type Dispatcher } from "undici";
import type { Asset } from "./signal.js";
import { binanceDispatcher } from "./binance-proxy.js";

const MINUTE_MS = 60_000;

function envNum(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Which side of the book got liquidated. Long liquidation = forced SELL. */
export type LiqSide = "long" | "short";
export type TradeDir = "UP" | "DOWN";

export interface LiqEvent {
  asset: Asset;
  side: LiqSide;
  usd: number;
  at: number;
}

// ---------------------------------------------------------------------------
// Parser (pure — exported for tests)
// ---------------------------------------------------------------------------

const BINANCE_SYMBOL_TO_ASSET: Record<string, Asset> = {
  BTCUSDT: "BTC",
  BTCUSDC: "BTC",
  ETHUSDT: "ETH",
  ETHUSDC: "ETH",
};

/**
 * Binance `forceOrder` event: { e:"forceOrder", o:{ s, S, q, p, ap, z, T } }.
 * S = "SELL" means a LONG was force-closed (forced sell); "BUY" = short
 * squeezed. Notional = avg fill price * filled qty. Quarterly contracts
 * (BTCUSDT_250628…) are ignored on purpose. Accepts the combined-stream
 * wrapper { stream, data }; any other frame (e.g. the markPrice heartbeat)
 * has no `o` and yields [].
 */
export function parseBinanceLiq(msg: unknown, now: number): LiqEvent[] {
  if (Array.isArray(msg)) return msg.flatMap((x) => parseBinanceLiq(x, now));
  const m = msg as { o?: Record<string, unknown>; data?: { o?: Record<string, unknown> } } | null;
  const o = m?.o ?? m?.data?.o;
  if (!o) return [];
  const asset = BINANCE_SYMBOL_TO_ASSET[String(o.s)];
  if (!asset) return [];
  const usd = Number(o.z ?? o.q) * Number(o.ap ?? o.p);
  if (!(usd > 0)) return [];
  const S = String(o.S);
  if (S !== "SELL" && S !== "BUY") return [];
  const t = Number(o.T);
  return [
    {
      asset,
      side: S === "SELL" ? "long" : "short",
      usd,
      at: Number.isFinite(t) && Math.abs(t - now) < 5 * MINUTE_MS ? t : now,
    },
  ];
}

// ---------------------------------------------------------------------------
// Liquidation feed
// ---------------------------------------------------------------------------

export interface LiquidationReading {
  /** USD liquidated, recent window, on the side that pushes price in the trade's direction. */
  alignedUsd: number;
  /** USD liquidated, recent window, on the opposite side. */
  againstUsd: number;
  /** alignedUsd / typical aligned USD per recent-window. null while warming up. */
  alignedRatio: number | null;
}

export interface LiquidationFeedConfig {
  url: string;
  recentMin: number;
  baselineMin: number;
  warmupMin: number;
  /** Floor on the baseline so a dead-quiet baseline can't produce absurd ratios. */
  floorUsd: number;
  /** No frame of any kind for this long => socket is dead, reconnect. */
  staleMs: number;
}

export class LiquidationFeed {
  private readonly buckets = new Map<Asset, Map<number, { long: number; short: number }>>();
  private ws: WebSocket | null = null;
  private connectedSince: number | null = null;
  private lastMsgAt = 0;
  private backoffMs = 1_000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private stopped = false;
  private downLogged = false;

  constructor(private readonly cfg: LiquidationFeedConfig) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
  }

  /** Public so tests (and a future replay tool) can feed events directly. */
  record(ev: LiqEvent): void {
    const minute = Math.floor(ev.at / MINUTE_MS) * MINUTE_MS;
    let m = this.buckets.get(ev.asset);
    if (!m) this.buckets.set(ev.asset, (m = new Map()));
    const b = m.get(minute) ?? { long: 0, short: 0 };
    b[ev.side] += ev.usd;
    m.set(minute, b);
    const cutoff = ev.at - (this.cfg.baselineMin + this.cfg.recentMin + 5) * MINUTE_MS;
    for (const k of m.keys()) if (k < cutoff) m.delete(k);
  }

  /** Test hook: pretend the socket has been up since `at`. */
  markConnected(at: number): void {
    this.connectedSince = at;
  }

  /**
   * null when the feed isn't currently connected: no reading is better than a
   * reading built on a feed that may have missed the cascade.
   */
  read(asset: Asset, dir: TradeDir, now: number): LiquidationReading | null {
    if (this.connectedSince === null) return null;
    const m = this.buckets.get(asset) ?? new Map<number, { long: number; short: number }>();
    const alignedKey: LiqSide = dir === "DOWN" ? "long" : "short";
    const againstKey: LiqSide = dir === "DOWN" ? "short" : "long";

    const curMinute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
    const recentFrom = curMinute - (this.cfg.recentMin - 1) * MINUTE_MS;
    // Baseline only counts minutes this connection actually observed — after a
    // reconnect, the gap would make the baseline artificially quiet.
    const connectedMinute = Math.floor(this.connectedSince / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
    const baseFrom = Math.max(curMinute - this.cfg.baselineMin * MINUTE_MS, connectedMinute);

    let recentAligned = 0;
    let recentAgainst = 0;
    let baseAligned = 0;
    for (const [start, b] of m) {
      if (start >= recentFrom) {
        recentAligned += b[alignedKey];
        recentAgainst += b[againstKey];
      } else if (start >= baseFrom) {
        baseAligned += b[alignedKey];
      }
    }

    const spanMin = (recentFrom - baseFrom) / MINUTE_MS;
    let alignedRatio: number | null = null;
    if (spanMin >= this.cfg.warmupMin) {
      const typicalWindow = (baseAligned / spanMin) * this.cfg.recentMin;
      alignedRatio = recentAligned / Math.max(typicalWindow, this.cfg.floorUsd);
    }
    return { alignedUsd: recentAligned, againstUsd: recentAgainst, alignedRatio };
  }

  // --- connection management ------------------------------------------------

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      const dispatcher: Dispatcher | undefined = binanceDispatcher();
      ws = new WebSocket(this.cfg.url, dispatcher ? ({ dispatcher } as never) : undefined);
    } catch (e) {
      this.scheduleReconnect(`could not open socket: ${(e as Error).message}`);
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.connectedSince = Date.now();
      this.lastMsgAt = Date.now();
      this.backoffMs = 1_000;
      this.downLogged = false;
      console.log("[flow-risk] liquidation feed connected (binance)");
      // !forceOrder@arr can legitimately be silent for minutes, so liveness is
      // judged on the 1s markPrice heartbeat riding the same connection.
      if (this.watchdog) clearInterval(this.watchdog);
      this.watchdog = setInterval(() => {
        if (Date.now() - this.lastMsgAt > this.cfg.staleMs) {
          try {
            ws.close();
          } catch {
            /* close handler reconnects */
          }
          // close() on a half-dead TCP can take a while to fire 'close'
          // — don't wait on it.
          this.handleDown(ws, `no frames for ${Math.round(this.cfg.staleMs / 1000)}s`);
        }
      }, Math.max(1_000, Math.floor(this.cfg.staleMs / 3)));
      this.watchdog.unref?.();
    });

    ws.addEventListener("message", (ev: { data: unknown }) => {
      void this.onMessage(ev.data);
    });
    ws.addEventListener("close", () => this.handleDown(ws, "socket closed"));
    ws.addEventListener("error", (ev: unknown) => {
      const msg = (ev as { message?: string })?.message;
      this.handleDown(ws, `socket error${msg ? `: ${msg}` : ""}`);
    });
  }

  private handleDown(ws: WebSocket, reason: string): void {
    if (this.ws !== ws) return; // a newer socket already replaced this one
    this.ws = null;
    this.connectedSince = null;
    if (this.watchdog) clearInterval(this.watchdog);
    this.scheduleReconnect(reason);
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.reconnectTimer) return;
    if (!this.downLogged) {
      this.downLogged = true;
      console.error(
        `[flow-risk] liquidation feed down: ${reason} — readings are null until it ` +
          `reconnects (trading unaffected)`
      );
    }
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, wait);
    this.reconnectTimer.unref?.();
  }

  private async onMessage(raw: unknown): Promise<void> {
    try {
      this.lastMsgAt = Date.now(); // any frame counts as liveness
      let text: string;
      if (typeof raw === "string") text = raw;
      else if (raw instanceof ArrayBuffer) text = Buffer.from(raw).toString("utf8");
      else if (raw && typeof (raw as Blob).text === "function") text = await (raw as Blob).text();
      else return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      for (const e of parseBinanceLiq(parsed, Date.now())) this.record(e);
    } catch (e) {
      console.error(`[flow-risk] message handling failed: ${(e as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Open interest (Binance futures)
// ---------------------------------------------------------------------------

export interface OiReading {
  /** Percent change in OI over ~lookbackMin, e.g. -0.8 = OI down 0.8%. */
  changePct: number;
  lookbackMin: number;
}

export class OiTracker {
  private readonly samples = new Map<Asset, { t: number; oi: number }[]>();
  private readonly lastFetch = new Map<Asset, number>();
  private readonly inFlight = new Set<Asset>();
  private readonly warnedDown = new Set<Asset>();

  constructor(
    private readonly pollMs: number,
    private readonly lookbackMs: number
  ) {}

  /** Fire-and-forget safe: never throws, self-throttles, one request in flight per asset. */
  async sample(asset: Asset, now: number): Promise<void> {
    if (this.inFlight.has(asset)) return;
    if (now - (this.lastFetch.get(asset) ?? 0) < this.pollMs) return;
    this.inFlight.add(asset);
    this.lastFetch.set(asset, now);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6_000);
    try {
      const symbol = asset === "BTC" ? "BTCUSDT" : "ETHUSDT";
      const dispatcher = binanceDispatcher();
      const res = await fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`, {
        signal: controller.signal,
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { openInterest?: string };
      const oi = Number(body.openInterest);
      if (!(oi > 0)) throw new Error("bad openInterest payload");
      const arr = this.samples.get(asset) ?? [];
      arr.push({ t: now, oi });
      const cutoff = now - this.lookbackMs * 3;
      while (arr.length > 0 && arr[0]!.t < cutoff) arr.shift();
      this.samples.set(asset, arr);
      this.warnedDown.delete(asset);
    } catch (e) {
      if (!this.warnedDown.has(asset)) {
        this.warnedDown.add(asset);
        console.error(
          `[flow-risk] OI read failed for ${asset}: ${(e as Error).message} — OI context null until it recovers`
        );
      }
    } finally {
      clearTimeout(timer);
      this.inFlight.delete(asset);
    }
  }

  /** Test hook. */
  push(asset: Asset, t: number, oi: number): void {
    const arr = this.samples.get(asset) ?? [];
    arr.push({ t, oi });
    this.samples.set(asset, arr);
  }

  read(asset: Asset, now: number): OiReading | null {
    const arr = this.samples.get(asset);
    if (!arr || arr.length < 2) return null;
    const latest = arr[arr.length - 1]!;
    // A stale latest sample means the poll is failing — don't report it as current.
    if (now - latest.t > Math.max(this.pollMs * 4, 60_000)) return null;
    const target = now - this.lookbackMs;
    let base: { t: number; oi: number } | null = null;
    for (const s of arr) if (s.t <= target) base = s; // newest sample at/before the lookback point
    if (!base) return null; // not enough history yet
    return {
      changePct: (latest.oi / base.oi - 1) * 100,
      lookbackMin: (latest.t - base.t) / MINUTE_MS,
    };
  }
}

// ---------------------------------------------------------------------------
// Trap verdict (optional gate)
// ---------------------------------------------------------------------------

export interface FlowRiskReading {
  liqAlignedUsd: number | null;
  liqAgainstUsd: number | null;
  liqAlignedRatio: number | null;
  oiChangePct: number | null;
}

export interface TrapConfig {
  /** Aligned liquidations must be at least this multiple of their baseline… */
  liqRatioMin: number;
  /** …AND at least this many USD, per asset (BTC and ETH liquidate at very
   *  different scales; this also guards against a thin baseline inflating the ratio)… */
  liqUsdMin: Record<Asset, number>;
  /** …AND open interest must have fallen by at least this many percent. */
  oiDropPct: number;
}

export interface TrapVerdict {
  blocked: boolean;
  reason: string;
}

/**
 * "Forced flow" is confirmed only when ALL THREE agree: liquidation pressure
 * on our side is far above its norm, it's big in absolute dollars, AND open
 * interest is actually shrinking (positions closing, not new ones opening).
 * Any missing reading (feed down, warming up) means NOT confirmed => not
 * blocked: this gate may only ever refuse a trade on positive evidence, never
 * on absence of data, same fail-open posture as the other confirm gates.
 */
export function evaluateTrap(r: FlowRiskReading, cfg: TrapConfig, asset: Asset): TrapVerdict {
  if (r.liqAlignedRatio === null || r.liqAlignedUsd === null || r.oiChangePct === null) {
    return { blocked: false, reason: "insufficient data" };
  }
  const liqHot = r.liqAlignedRatio >= cfg.liqRatioMin && r.liqAlignedUsd >= cfg.liqUsdMin[asset];
  const oiShrinking = r.oiChangePct <= -cfg.oiDropPct;
  const reason =
    `liq ${r.liqAlignedRatio.toFixed(1)}x ($${Math.round(r.liqAlignedUsd / 1000)}k) ` +
    `oi ${r.oiChangePct >= 0 ? "+" : ""}${r.oiChangePct.toFixed(2)}%`;
  return { blocked: liqHot && oiShrinking, reason };
}

// ---------------------------------------------------------------------------
// Facade used by index.ts
// ---------------------------------------------------------------------------

const EMPTY: FlowRiskReading = {
  liqAlignedUsd: null,
  liqAgainstUsd: null,
  liqAlignedRatio: null,
  oiChangePct: null,
};

const r2 = (n: number): number => Number(n.toFixed(2));

export interface FlowRisk {
  enabled: boolean;
  describe(): string;
  start(): void;
  /** Call once per cycle per asset; self-throttled, never throws, don't await. */
  sampleOi(asset: Asset, now: number): void;
  read(asset: Asset, dir: TradeDir, now: number): FlowRiskReading;
  /** Reading + verdict against the OF_TRAP_* thresholds. Only acted on when OF_REQUIRE_TRAP_CHECK is on. */
  checkTrap(asset: Asset, dir: TradeDir, now: number): TrapVerdict & { reading: FlowRiskReading };
}

export function createFlowRisk(): FlowRisk {
  const enabled = (process.env.OF_FLOW_RISK_LOG ?? "true") !== "false";
  if (!enabled) {
    return {
      enabled: false,
      describe: () => "off",
      start() {},
      sampleOi() {},
      read: () => EMPTY,
      checkTrap: () => ({ blocked: false, reason: "flow-risk off", reading: EMPTY }),
    };
  }

  // Binance split its futures websocket bases in 2026; !forceOrder@arr is on
  // /market. The markPrice stream is a 1s heartbeat for the stale-socket
  // watchdog. Override with OF_LIQ_BINANCE_WS_URL if Binance moves it again.
  const url =
    process.env.OF_LIQ_BINANCE_WS_URL ??
    "wss://fstream.binance.com/market/stream?streams=!forceOrder@arr/btcusdt@markPrice@1s";

  const recentMin = envNum("OF_LIQ_RECENT_MIN", 3);
  const feed = new LiquidationFeed({
    url,
    recentMin,
    baselineMin: envNum("OF_LIQ_BASELINE_MIN", 60),
    warmupMin: envNum("OF_LIQ_WARMUP_MIN", 15),
    floorUsd: envNum("OF_LIQ_FLOOR_USD", 50_000),
    staleMs: envNum("OF_LIQ_STALE_MS", 30_000),
  });
  const lookbackMin = envNum("OF_OI_LOOKBACK_MIN", 5);
  const oi = new OiTracker(envNum("OF_OI_POLL_MS", 15_000), lookbackMin * MINUTE_MS);
  // OF_TRAP_LIQ_USD_MIN sets both assets; the _BTC/_ETH variants override it.
  const usdBoth = process.env.OF_TRAP_LIQ_USD_MIN;
  const trapCfg: TrapConfig = {
    liqRatioMin: envNum("OF_TRAP_LIQ_RATIO_MIN", 5),
    liqUsdMin: {
      BTC: envNum("OF_TRAP_LIQ_USD_MIN_BTC", usdBoth ? envNum("OF_TRAP_LIQ_USD_MIN", 250_000) : 250_000),
      ETH: envNum("OF_TRAP_LIQ_USD_MIN_ETH", usdBoth ? envNum("OF_TRAP_LIQ_USD_MIN", 100_000) : 100_000),
    },
    oiDropPct: envNum("OF_TRAP_OI_DROP_PCT", 0.3),
  };

  const read = (asset: Asset, dir: TradeDir, now: number): FlowRiskReading => {
    const liq = feed.read(asset, dir, now);
    const o = oi.read(asset, now);
    return {
      liqAlignedUsd: liq ? Math.round(liq.alignedUsd) : null,
      liqAgainstUsd: liq ? Math.round(liq.againstUsd) : null,
      liqAlignedRatio: liq?.alignedRatio != null ? r2(liq.alignedRatio) : null,
      oiChangePct: o ? Number(o.changePct.toFixed(3)) : null,
    };
  };

  return {
    enabled: true,
    describe: () =>
      `binance liquidations (recent=${recentMin}min) + OI (lookback=${lookbackMin}min); ` +
      `trap thresholds: liq>=${trapCfg.liqRatioMin}x & >=$${trapCfg.liqUsdMin.BTC / 1000}k BTC/$${trapCfg.liqUsdMin.ETH / 1000}k ETH, OI<=-${trapCfg.oiDropPct}%`,
    start: () => feed.start(),
    sampleOi: (asset, now) => {
      void oi.sample(asset, now);
    },
    read,
    checkTrap(asset, dir, now) {
      const reading = read(asset, dir, now);
      return { ...evaluateTrap(reading, trapCfg, asset), reading };
    },
  };
}