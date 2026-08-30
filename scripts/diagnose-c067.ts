// One-off diagnostic — run once against the same config/RPC the bot uses.
// Does not trade, does not write to the journal. Just dumps what
// getMarketOnchain actually sees for the stuck market, plus a couple of
// sibling markets that DID settle fine, so we can diff the shapes.
//
// Also dumps every contract/wallet address the bot's config resolves to
// (exchange, binaryModule, wallet) — useful for e.g. looking the exchange
// contract up on the Somnia explorer to check its ABI for a relayed/
// operator fill function (see copy-trade ARCHITECTURE.md).
//
// Usage (from strategies/ec-oracle-follow):
//   npx tsx ../../scripts/diagnose-c067.ts
//
// Or wherever your createExchange/loadConfig live relative to this file —
// adjust the import paths below to match your actual package layout.

import { createExchange, loadConfig } from "@dreamdex-bot-kit/ec-core";

const STUCK_MARKET_ID =
  "0x000000000000000000000000000000000000000000000000000000000000c067" as `0x${string}`;

// Fill these in from decisions.jsonl with a couple of market_ids that DID
// get a matching "settlement" record — same window/asset shape as c067,
// ideally trades placed around the same time so pool recycling timing lines
// up. This is the actual point of the script: diff a known-good id against
// the stuck one using the exact same call the bot makes.
const KNOWN_GOOD_MARKET_IDS: `0x${string}`[] = [
  "0x000000000000000000000000000000000000000000000000000000000000bfe3", // BTC 14:15 window, settled LOSS in 14min
  "0x000000000000000000000000000000000000000000000000000000000000bfe4", // ETH 14:15 window, settled WIN in 14min
  "0x000000000000000000000000000000000000000000000000000000000000c00f", // BTC 14:30 window, PENDING at time of last log excerpt
  "0x000000000000000000000000000000000000000000000000000000000000bf5e", // settled WIN earlier at 13:30, symbol/shape unknown — good baseline
];

async function dump(label: string, marketId: `0x${string}`, ctx: Awaited<ReturnType<typeof createExchange>>) {
  console.log(`\n=== ${label} (${marketId}) ===`);
  try {
    const onchain = await ctx.exchange.client.getMarketOnchain(marketId);
    console.log(JSON.stringify(onchain, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  } catch (e) {
    console.log(`THREW: ${(e as Error).message}`);
    console.log((e as Error).stack);
  }
}

/**
 * Dumps every address the bot's config/exchange client resolves to. Tries
 * a handful of plausible property names since the exact shape of `ctx` /
 * `ctx.exchange` / `ctx.config.addresses` isn't documented here — this is
 * deliberately over-inclusive (logs "(not found)" rather than throwing on
 * a missing field) so one run tells you what's actually available without
 * needing to guess the right accessor first.
 */
function dumpAddresses(ctx: Awaited<ReturnType<typeof createExchange>>) {
  console.log("\n=== addresses ===");

  const addresses = (ctx.config as any)?.addresses ?? {};
  const candidates: Array<[string, unknown]> = [
    ["config.addresses.binaryModule", addresses.binaryModule],
    ["config.addresses.exchange", addresses.exchange],
    ["config.addresses.ecExchange", addresses.ecExchange],
    ["config.addresses.usdso", addresses.usdso ?? addresses.USDso ?? addresses.collateral],
    ["exchange.address", (ctx.exchange as any)?.address],
    ["exchange.contractAddress", (ctx.exchange as any)?.contractAddress],
    ["exchange.client.address", (ctx.exchange as any)?.client?.address],
    ["exchange.client.contractAddress", (ctx.exchange as any)?.client?.contractAddress],
    ["exchange.walletAddress (signer, if any)", (ctx.exchange as any)?.walletAddress],
  ];

  for (const [label, value] of candidates) {
    console.log(`${label}: ${value ?? "(not found)"}`);
  }

  // Anything not caught by the guesses above — dump the raw config/exchange
  // objects (minus obviously sensitive fields) so a field with an
  // unexpected name still shows up.
  console.log("\nfull config.addresses object:", JSON.stringify(addresses, null, 2));
  console.log(
    "\nctx.exchange own keys (for spotting an address field the guesses above missed):",
    Object.keys(ctx.exchange as any),
  );
}

/**
 * Digs into ctx.exchange.client — the actual object making calls, per the
 * previous run's key dump — looking for anything that exposes an ABI or a
 * contract interface we can read function signatures off of directly,
 * without needing explorer access. Deliberately tries many possible shapes
 * (viem, ethers v5/v6, a hand-rolled wrapper) since we don't know which
 * this SDK uses under the hood.
 */
function dumpClientAbi(ctx: Awaited<ReturnType<typeof createExchange>>) {
  console.log("\n=== ctx.exchange.client introspection ===");
  const client = (ctx.exchange as any)?.client;
  if (!client) {
    console.log("(no client found on ctx.exchange)");
    return;
  }

  console.log("client own keys:", Object.keys(client));
  console.log("client prototype methods:", Object.getOwnPropertyNames(Object.getPrototypeOf(client)));

  // Common places an ABI/interface might live across SDK styles:
  const abiCandidates: Array<[string, unknown]> = [
    ["client.abi", client.abi],
    ["client.contract?.interface?.fragments", client.contract?.interface?.fragments],
    ["client.contract?.abi", client.contract?.abi],
    ["client.binaryPool?.abi", client.binaryPool?.abi],
    ["client.pool?.abi", client.pool?.abi],
    ["client.exchange?.abi", client.exchange?.abi],
  ];

  for (const [label, value] of abiCandidates) {
    if (!value) continue;
    console.log(`\n--- ${label} ---`);
    try {
      // ethers Interface fragments have `.format?.()`; viem/raw ABIs are
      // plain arrays of {name, type, inputs} — handle both without
      // assuming which one this is.
      const fns = (value as any[])
        .filter((f: any) => (f.type ?? f.format?.()) && (f.type === "function" || typeof f.format === "function"))
        .map((f: any) => (typeof f.format === "function" ? f.format("full") : `${f.name}(${(f.inputs ?? []).map((i: any) => i.type).join(",")})`));
      console.log(fns.join("\n"));
    } catch (e) {
      console.log(`(couldn't format — raw dump) ${JSON.stringify(value).slice(0, 2000)}`);
    }
  }

  // Fallback: grep every function NAME on the client/prototype for anything
  // suggesting a relayed/operator/on-behalf call, even if we can't get a
  // full ABI. This alone can answer the question if the SDK just exposes
  // a method like client.placeLimitFor(...) directly.
  const allMethodNames = [
    ...Object.keys(client),
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(client)),
  ];
  const suspects = allMethodNames.filter((n) =>
    /for|onbehalf|relay|operator|delegate|taker|beneficiary/i.test(n),
  );
  console.log("\nmethod/property names matching relay/operator/onBehalf/for/taker/beneficiary:");
  console.log(suspects.length ? suspects.join(", ") : "(none found)");
}

async function main() {
  const ctx = createExchange({ withSigner: !loadConfig().dryRun });

  console.log("config.addresses.binaryModule:", (ctx.config as any).addresses?.binaryModule ?? "(unset!)");
  console.log("indexerUrl:", ctx.config.indexerUrl);

  dumpAddresses(ctx);
  dumpClientAbi(ctx);

  // c067's symbol carries a strike suffix ("...-1500-C067/tUSDC") that bfe3/
  // bfe4/c00f do NOT have ("...-1415/tUSDC", no suffix). That's a real
  // structural difference worth confirming isn't the actual cause — flag it
  // loudly rather than bury it in the JSON dump below.
  console.log(
    "\nNOTE: c067's journal symbol is 'BTC-0-28AUG26-1500-C067/tUSDC' — has a strike\n" +
      "suffix the known-good siblings below do not. Worth checking marketInfo()/\n" +
      "the indexer row for whether that suffix changes how info.marketId got\n" +
      "resolved upstream, independent of what getMarketOnchain says here.\n",
  );

  await dump("STUCK — c067", STUCK_MARKET_ID, ctx);

  for (const id of KNOWN_GOOD_MARKET_IDS) {
    await dump("known-good", id, ctx);
  }

  await dumpOperatorHub(ctx);

  process.exit(0);
}

/**
 * The real point of this run: `listOperators`/`getOperatorHubAccount`/
 * `createOperatorAdmin` on the client suggest DreamDEX may already have a
 * delegated-trading permission system — if so it could replace both the
 * allowance-pull design AND the vault-custody fallback (no funds ever
 * leave the user's wallet, no contract we have to own/audit). Calls each
 * read-only method defensively (many will legitimately need an address
 * argument we don't have yet, or may throw if nothing's registered) so one
 * run tells us the actual shape without crashing on the first miss.
 *
 * ALSO checking here whether any of this exposes a fee hook — if DreamDEX's
 * own operator/relayer path supports a builder/operator fee (there's a
 * `listBuilderFees`/`listBuilderApprovals` on the client too, worth a
 * look), that could mean we get fee-on-profit for free instead of needing
 * our own settlement logic to deduct it.
 */
async function dumpOperatorHub(ctx: Awaited<ReturnType<typeof createExchange>>) {
  console.log("\n=== operator hub / delegation introspection ===");
  const client = (ctx.exchange as any)?.client;
  if (!client) {
    console.log("(no client found)");
    return;
  }

  const myAddress = (ctx.exchange as any)?.walletAddress ?? null;
  console.log("bot's own wallet address (for testing self-lookups):", myAddress ?? "(none — dry run, no signer)");

  const tryCall = async (label: string, fn: () => Promise<unknown>) => {
    console.log(`\n--- ${label} ---`);
    try {
      const result = await fn();
      console.log(JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    } catch (e) {
      console.log(`THREW: ${(e as Error).message}`);
    }
  };

  // No-arg / list calls first — safest, most likely to just work and show
  // us the shape of an "operator" record (does it have a spend cap? a
  // scope like "binary only"? a fee field?).
  if (typeof client.listOperators === "function") {
    await tryCall("listOperators()", () => client.listOperators());
  }
  if (typeof client.countOperators === "function") {
    await tryCall("countOperators()", () => client.countOperators());
  }
  if (typeof client.listOperatorHubAccounts === "function") {
    await tryCall("listOperatorHubAccounts()", () => client.listOperatorHubAccounts());
  }

  // Single-record lookups — try with the bot's own address as a plausible
  // first argument, just to see the shape of a "not found" vs a real
  // record and what fields it has.
  if (myAddress && typeof client.getOperator === "function") {
    await tryCall(`getOperator(${myAddress})`, () => client.getOperator(myAddress));
  }
  if (myAddress && typeof client.getOperatorHubAccount === "function") {
    await tryCall(`getOperatorHubAccount(${myAddress})`, () => client.getOperatorHubAccount(myAddress));
  }

  // Fee-hook check — does DreamDEX's own relayer/builder path already
  // support skimming a fee, independent of whatever we build ourselves?
  if (typeof client.listBuilderFees === "function") {
    await tryCall("listBuilderFees()", () => client.listBuilderFees());
  }
  if (typeof client.listBuilderApprovals === "function") {
    await tryCall("listBuilderApprovals()", () => client.listBuilderApprovals());
  }
  if (typeof client.listProtocolFees === "function") {
    await tryCall("listProtocolFees()", () => client.listProtocolFees());
  }

  // createOperatorAdmin sounds like a WRITE call (creates/registers
  // something on-chain) — deliberately NOT calling it here. This script
  // stays read-only per its own header. Just flag that it exists so it's
  // not missed in the summary.
  console.log(
    "\nNOTE: client.createOperatorAdmin exists but was NOT called (looks like a write/" +
      "state-changing method — this script stays read-only). Once the read calls above " +
      "clarify what an 'operator' record actually grants, that's the one to look at for " +
      "how to register the copy-bot as an operator, if this path pans out.",
  );

  await dumpBuilderPath(ctx, client, myAddress);
}

/**
 * Follow-up on listBuilderApprovals: those records show { user, builder,
 * maxFeeBpsTimes1k, market, pool } — this looks like exactly the delegated-
 * trading-with-fee mechanism we want, IF it supports a global/wildcard
 * approval rather than requiring one approval per market (bad UX for
 * "set and forget" copy trading). This checks:
 *   1) whether any existing approval covers "all markets" (market field
 *      that's zero/null, or a market===pool pattern like two rows we saw)
 *   2) getMarketFees()/listSettlementFees() for the ACTUAL fee split logic
 *      applied at settlement — to confirm the builder fee is really paid
 *      out automatically rather than just being a recorded cap
 *   3) whether quoteBinaryOrder/getOrderOnchain or any order-shaped method
 *      accepts a `builder` argument, which is what we'd actually need to
 *      call from the copy-bot
 */
async function dumpBuilderPath(ctx: any, client: any, myAddress: string | null) {
  console.log("\n=== builder-approval path introspection ===");

  if (typeof client.listBuilderApprovals === "function") {
    const all = await client.listBuilderApprovals().catch((e: Error) => {
      console.log(`listBuilderApprovals() THREW: ${e.message}`);
      return [];
    });
    const wildcardLike = (all as any[]).filter(
      (r) => !r.market || r.market === "0x0" || /^0x0+$/.test(r.market ?? "") || r.market === r.pool,
    );
    console.log(
      `${(all as any[]).length} total approvals seen; ${wildcardLike.length} look wildcard/global-ish ` +
        `(empty market, all-zero market, or market===pool):`,
    );
    console.log(JSON.stringify(wildcardLike.slice(0, 5), null, 2));
  }

  for (const fn of ["getMarketFees", "listSettlementFees"]) {
    if (typeof client[fn] === "function") {
      console.log(`\n--- ${fn}() ---`);
      try {
        console.log(
          JSON.stringify(await client[fn](), (_, v) => (typeof v === "bigint" ? v.toString() : v), 2).slice(
            0,
            3000,
          ),
        );
      } catch (e) {
        console.log(`THREW: ${(e as Error).message}`);
      }
    }
  }

  // Does quoteBinaryOrder (the read-only quote path, safe to call) accept
  // or return anything mentioning "builder"? Cheapest way to confirm the
  // param exists without needing a real market/order to test against.
  if (typeof client.quoteBinaryOrder === "function") {
    console.log("\nquoteBinaryOrder.length (arg count, hints at signature):", client.quoteBinaryOrder.length);
    console.log("quoteBinaryOrder.toString() (first 500 chars, may reveal param names if unminified):");
    console.log(client.quoteBinaryOrder.toString().slice(0, 500));
  }

  console.log(
    "\nNEXT STEP if this looks promising: grep the ec-core package source directly for the " +
      "string 'builder' in its type definitions — that'll show every function signature that " +
      "takes a builder param, including the actual placeLimit/placeOrder variant, faster than " +
      "guessing more method names here. From your repo root:\n" +
      "  grep -rn 'builder' node_modules/@dreamdex-bot-kit/ec-core/dist/*.d.ts\n" +
      "or wherever its type declarations live if dist/ isn't it.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});