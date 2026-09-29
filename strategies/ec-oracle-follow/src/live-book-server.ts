/**
 * Internal HTTP endpoint the copy service reaches via prod-server proxy.
 * Fetches the order book live from the exchange 
 */
import { createServer } from "node:http";
import { activeMarkets, type EcContext } from "@dreamdex-bot-kit/ec-core";
import { recordOrderBook } from "./orderbook-cache.js";
import { withTimeout } from "./timeout.js";

const LIVE_BOOK_COALESCE_MS = 300;
const LIVE_BOOK_PORT = Number(process.env.LIVE_BOOK_PORT ?? 8791);
const BOOK_DEPTH = Number(process.env.OF_BOOK_DEPTH ?? 15);
/** Refresh SDK market map so new window symbols aren't "unknown". */
const MARKETS_TTL_MS = Number(process.env.LIVE_BOOK_MARKETS_TTL_MS ?? 30_000);

let marketsLoadedAt = 0;
let marketsInFlight: Promise<void> | null = null;

async function ensureMarkets(ctx: EcContext): Promise<void> {
  if (Date.now() - marketsLoadedAt < MARKETS_TTL_MS) return;
  if (marketsInFlight) {
    await marketsInFlight;
    return;
  }
  marketsInFlight = (async () => {
    try {
      await withTimeout(activeMarkets(ctx), 15_000, "liveBook.activeMarkets");
      marketsLoadedAt = Date.now();
    } finally {
      marketsInFlight = null;
    }
  })();
  await marketsInFlight;
}

const inFlight = new Map<
  string,
  {
    promise: Promise<{ bids: [number, number][]; asks: [number, number][] }>;
    startedAt: number;
  }
>();

function getLiveBook(
  ctx: EcContext,
  symbol: string
): Promise<{ bids: [number, number][]; asks: [number, number][] }> {
  const hit = inFlight.get(symbol);
  if (hit && Date.now() - hit.startedAt < LIVE_BOOK_COALESCE_MS) {
    return hit.promise;
  }
  const promise = withTimeout(
    ctx.exchange.fetchOrderBook(symbol, BOOK_DEPTH),
    4_000,
    `liveBook(${symbol})`
  ).finally(() => {
    if (inFlight.get(symbol)?.promise === promise) inFlight.delete(symbol);
  });
  inFlight.set(symbol, { promise, startedAt: Date.now() });
  return promise;
}

export function startLiveBookServer(ctx: EcContext): void {
  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname !== "/api/live-book") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const symbol = url.searchParams.get("symbol");
    if (!symbol) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "symbol required" }));
      return;
    }

    try {
      await ensureMarkets(ctx);
      const book = await getLiveBook(ctx, symbol);
      recordOrderBook(symbol, book);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(
        JSON.stringify({
          symbol,
          asks: book.asks,
          bids: book.bids,
          updatedAt: Date.now(),
        })
      );
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  });

  server.listen(LIVE_BOOK_PORT, "127.0.0.1", () => {
    console.log(`[live-book] 127.0.0.1:${LIVE_BOOK_PORT}`);
  });
}