import { createExchange, settledMarkets } from "@dreamdex-bot-kit/ec-core";

const ctx = createExchange({ withSigner: false });
const settled = await settledMarkets(ctx, 500); // widen scan in case they've rolled off page 1

// Targets: asset + the UTC date-time embedded in the bot's log symbol
const targets = [
  { asset: "BTC", label: "BTC-1415", iso: "2026-09-09T14:15:00Z" },
  { asset: "BTC", label: "BTC-1445", iso: "2026-09-09T14:45:00Z" },
  { asset: "ETH", label: "ETH-1445", iso: "2026-09-09T14:45:00Z" },
];

for (const t of targets) {
  const epoch = Math.floor(new Date(t.iso).getTime() / 1000);
  console.log(`\n=== ${t.label} (expiry epoch ${epoch}) ===`);
  const matches = settled.filter(m => m.symbol.startsWith(t.asset) && m.expiry === epoch);
  if (matches.length === 0) {
    // fall back: show anything within +/- 60s in case expiry isn't exactly on the 15-min mark
    const near = settled.filter(m => m.symbol.startsWith(t.asset) && Math.abs(m.expiry - epoch) <= 60);
    console.log("exact match: NONE. nearby (±60s):", JSON.stringify(near, null, 2));
  } else {
    console.log(JSON.stringify(matches, null, 2));
  }
}
