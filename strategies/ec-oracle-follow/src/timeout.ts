/**
 * Node's fetch has no default timeout, and the same is true for whatever
 * @dreamdex-bot-kit/ec-core's SDK calls do under the hood (fetchPrice,
 * fetchOrderBook, getOpeningPrices, getMarketOnchain, activeMarkets,
 * maybeClaim, ...) — we don't control those internals, so we can't patch a
 * timeout INTO them the way telegram.ts wraps its own fetch calls. What we
 * CAN do is race whatever we're awaiting against a timer at the call sites
 * we do own, so a hang anywhere inside one SDK call doesn't freeze the
 * bot's sequential main loop forever with no crash and no restart trigger.
 *
 * Deliberately NOT used around placeLimit() (order submission) — if a
 * timeout fires after the tx was already broadcast, treating that as "it
 * didn't happen" and retrying risks a double-fill. That needs a real
 * idempotency/reconciliation design, not a blind wrap.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}
