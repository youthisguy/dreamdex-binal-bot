import { createExchange, activeMarkets, settledMarkets } from "@dreamdex-bot-kit/ec-core";

const ctx = createExchange({ withSigner: false });
const targets = [
  "BTC-0-09SEP26-1415/USDso",
  "BTC-0-09SEP26-1445/USDso",
  "ETH-0-09SEP26-1445/USDso",
];

const active = await activeMarkets(ctx);
const settled = await settledMarkets(ctx, 200);

for (const sym of targets) {
  const a = active.find(m => m.symbol === sym);
  const s = settled.find(r => r.symbol === sym);
  console.log(sym, "->", a?.info.marketId ?? s?.marketId ?? "NOT FOUND");
}
