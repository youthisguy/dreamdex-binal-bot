/**
 * A live order-book snapshot the copy-trade service polls, written the same
 * way volume-pace.ts writes volume-pulse.json: to a small JSON file next to
 * the bot's own cwd, atomically (tmp + rename) so a reader never sees a
 * half-written file. 
 * record() is called every time the main loop already fetches a book (it
 * fetches the YES book unconditionally per market each cycle, and the
 * favoured leg's book again while a signal is actively filling) — this adds
 * no extra exchange calls, it just remembers what was already read.
 *
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface BookSnapshot {
  symbol: string;
  bids: [number, number][];
  asks: [number, number][];
  updatedAt: number;
}

const cache = new Map<string, BookSnapshot>();

/** Remember a book that was just fetched for trading — no extra exchange call. */
export function recordOrderBook(
  symbol: string,
  book: { bids: [number, number][]; asks: [number, number][] }
): void {
  cache.set(symbol, {
    symbol,
    bids: book.bids,
    asks: book.asks,
    updatedAt: Date.now(),
  });
}

/**
 * Writes the whole cache to a small JSON file, same atomic tmp+rename
 * pattern as writePulse(). Never throws — a snapshot write must not
 * interrupt trading. Call once per cycle (not per fetch — no need to hit
 * disk more than once a cycle).
 */
export function writeOrderBookSnapshot(path: string, maxAgeMs = 120_000): void {
  try {
    const now = Date.now();
    const books: Record<string, BookSnapshot> = {};
    for (const [symbol, snap] of cache) {
      // Drop anything stale (a market that's stopped trading/left the
      // active set) rather than let the file grow forever with dead symbols.
      if (now - snap.updatedAt > maxAgeMs) {
        cache.delete(symbol);
        continue;
      }
      books[symbol] = snap;
    }
    const payload = { updated_at: new Date().toISOString(), books };
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload));
    renameSync(tmp, path);
  } catch (e) {
    console.error(`orderbook snapshot write failed: ${(e as Error).message}`);
  }
}