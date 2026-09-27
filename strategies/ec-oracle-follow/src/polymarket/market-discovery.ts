/**
 * Discovers the currently-tradable Polymarket 15m Up/Down market for an
 * asset, without needing to list/search markets.
 *
 * Polymarket's short-window Up/Down series uses a deterministic slug:
 *   "{asset}-updown-{window}-{unixWindowStartSeconds}"
 * e.g. "btc-updown-15m-1762755300" — a market that opened at that unix
 * timestamp and resolves 15 minutes later. There is no need to page
 * through an events list; we can compute the current window's start time
 * ourselves and fetch that exact slug.
 *
 * This mirrors the role DreamDEX's activeMarkets()/getOpeningPrices() SDK
 * calls played in index.ts, but Polymarket has no equivalent "list what's
 * tradable right now" call for this series — the slug IS the lookup key.
 */

const GAMMA_HOST = process.env.POLY_GAMMA_HOST ?? "https://gamma-api.polymarket.com";
const WINDOW_MIN = 15;
const WINDOW_MS = WINDOW_MIN * 60_000;

export type UpDownAsset = "btc" | "eth" | "sol" | "xrp" | "doge" | "bnb";

export interface ResolvedMarket {
  slug: string;
  conditionId: string;
  /** Outcome token IDs, in the order Gamma returns them for this market. */
  upTokenId: string;
  downTokenId: string;
  question: string;
  /** Window end time, ms epoch — same role as expiryMs elsewhere in the codebase. */
  endMs: number;
  closed: boolean;
}

/**
 * Rounds `atMs` down to the most recent 15-minute boundary and returns that
 * boundary's slug. `offsetWindows` shifts by whole windows (e.g. 1 = the
 * next window, -1 = the previous one) — useful for pre-fetching the next
 * market shortly before the current one closes.
 */
export function computeSlug(asset: UpDownAsset, atMs: number, offsetWindows = 0): string {
  const windowStartMs = Math.floor(atMs / WINDOW_MS) * WINDOW_MS + offsetWindows * WINDOW_MS;
  const windowStartSec = Math.floor(windowStartMs / 1000);
  return `${asset}-updown-${WINDOW_MIN}m-${windowStartSec}`;
}

interface GammaMarket {
  conditionId: string;
  question: string;
  clobTokenIds: string; // JSON-encoded string array: '["up_token_id","down_token_id"]'
  endDate: string;
  closed: boolean;
}

/**
 * Fetches a single market by slug from the Gamma API and normalizes it.
 * Returns null (not a thrown error) when the slug doesn't exist yet/anymore
 * — the caller's polling loop treats "not found" as "not tradable this
 * instant," not as a fault, since a market briefly not existing at a window
 * boundary is expected, not exceptional.
 */
export async function fetchMarketBySlug(slug: string): Promise<ResolvedMarket | null> {
  const res = await fetch(`${GAMMA_HOST}/markets/slug/${slug}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`gamma markets/slug/${slug}: HTTP ${res.status}`);
  }
  const raw = (await res.json()) as GammaMarket;
  if (!raw?.conditionId || !raw?.clobTokenIds) return null;

  let tokenIds: string[];
  try {
    tokenIds = JSON.parse(raw.clobTokenIds);
  } catch {
    throw new Error(`gamma markets/slug/${slug}: unparseable clobTokenIds`);
  }
  const [upTokenId, downTokenId] = tokenIds;
  if (!upTokenId || !downTokenId) {
    throw new Error(`gamma markets/slug/${slug}: expected 2 token ids, got ${tokenIds.length}`);
  }

  return {
    slug,
    conditionId: raw.conditionId,
    upTokenId,
    downTokenId,
    question: raw.question,
    endMs: new Date(raw.endDate).getTime(),
    closed: raw.closed,
  };
}

/**
 * Convenience wrapper matching the shape index.ts's main loop actually
 * wants: "give me the live window for this asset right now." Tries the
 * current window first, then the next one — covers the few-second gap
 * right at a boundary where the current slug has closed but the next
 * one's market object may not have propagated to Gamma yet (rare, but
 * cheap to guard against with one extra fetch).
 */
export async function getLiveWindow(asset: UpDownAsset, now = Date.now()): Promise<ResolvedMarket | null> {
  const current = await fetchMarketBySlug(computeSlug(asset, now, 0));
  if (current && !current.closed && current.endMs > now) return current;

  const next = await fetchMarketBySlug(computeSlug(asset, now, 1));
  if (next && !next.closed) return next;

  return null;
}
