/**
 * Manual, one-shot smoke test for the Polymarket integration — run this
 * BEFORE touching index.ts. It exercises the four things step 1 of the
 * migration needs proven: market discovery, book fetch, order placement,
 * and cancellation.
 *
 * Places a real but harmless order: a tiny BUY far below the current bid
 * (default 1 share at $0.01), which will sit unfilled on the book, then
 * cancels it. It never rests near the touch and never lets a market order
 * through, so this cannot accidentally take a real position.
 *
 * Usage:
 *   npx tsx polymarket/smoke-test.ts btc
 */
import { OrderType, Side } from "@polymarket/clob-client-v2";
import { getLiveWindow, type UpDownAsset } from "./market-discovery.js";
import { getClobClient } from "./clob-client.js";

const TEST_PRICE = 0.01; // deliberately far from any realistic mid
const TEST_SIZE = 1; // shares

async function main() {
  const asset = (process.argv[2] as UpDownAsset) ?? "btc";

  console.log(`[1/4] Discovering live 15m window for ${asset}...`);
  const market = await getLiveWindow(asset);
  if (!market) {
    console.error(`No live ${asset} 15m window found — try again near a :00/:15/:30/:45 boundary.`);
    process.exit(1);
  }
  console.log(`  slug=${market.slug}`);
  console.log(`  question="${market.question}"`);
  console.log(`  conditionId=${market.conditionId}`);
  console.log(`  upTokenId=${market.upTokenId}`);
  console.log(`  downTokenId=${market.downTokenId}`);
  console.log(`  ends=${new Date(market.endMs).toISOString()}`);

  console.log(`\n[2/4] Setting up authenticated CLOB client...`);
  const client = await getClobClient();
  console.log(`  ok`);

  console.log(`\n[3/4] Fetching order book for the UP token...`);
  const book = await client.getOrderBook(market.upTokenId);
  const bestBid = book.bids?.[0];
  const bestAsk = book.asks?.[0];
  console.log(`  best bid: ${bestBid ? `${bestBid.price} x ${bestBid.size}` : "(none)"}`);
  console.log(`  best ask: ${bestAsk ? `${bestAsk.price} x ${bestAsk.size}` : "(none)"}`);

  console.log(`\n[4/4] Placing + cancelling a test order (${TEST_SIZE} @ $${TEST_PRICE}, UP token)...`);
  const order = await client.createOrder({
    tokenID: market.upTokenId,
    price: TEST_PRICE,
    side: Side.BUY,
    size: TEST_SIZE,
  });
  const posted = await client.postOrder(order, OrderType.GTC);
  if (!posted?.success) {
    throw new Error(`order post failed: ${JSON.stringify(posted)}`);
  }
  console.log(`  posted orderID=${posted.orderID}`);

  const cancelled = await client.cancelOrder({ orderID: posted.orderID });
  console.log(`  cancel result: ${JSON.stringify(cancelled)}`);

  console.log(`\nAll four checks passed.`);
}

main().catch((e) => {
  console.error(`smoke test failed: ${(e as Error).message}`);
  process.exit(1);
});