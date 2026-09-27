/**
 * Optional forward-proxy dispatcher for Binance REST calls only.
 */
import { ProxyAgent, type Dispatcher } from "undici";

let cached: Dispatcher | undefined;
let attempted = false;

export function binanceDispatcher(): Dispatcher | undefined {
  if (!attempted) {
    attempted = true;
    const url = process.env.BINANCE_PROXY_URL;
    if (url) cached = new ProxyAgent(url);
  }
  return cached;
}