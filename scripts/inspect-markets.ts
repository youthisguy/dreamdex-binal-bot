import { createExchange, activeMarkets, settledMarkets } from "@dreamdex-bot-kit/ec-core";

const ctx = createExchange({ withSigner: false });

const active = await activeMarkets(ctx);
const settled = await settledMarkets(ctx, 200);

console.log("=== active count:", active.length, "===");
console.log(JSON.stringify(active[0], null, 2));

console.log("=== settled count:", settled.length, "===");
console.log(JSON.stringify(settled[0], null, 2));

// Look for anything containing "1415" or "1445" anywhere in the object,
// regardless of which field it lives in
const hay = (m: any) => JSON.stringify(m);
console.log("=== settled matches containing 1415 or 1445 ===");
for (const m of settled) {
  if (hay(m).includes("1415") || hay(m).includes("1445")) {
    console.log(JSON.stringify(m, null, 2));
  }
}
console.log("=== active matches containing 1415 or 1445 ===");
for (const m of active) {
  if (hay(m).includes("1415") || hay(m).includes("1445")) {
    console.log(JSON.stringify(m, null, 2));
  }
}
