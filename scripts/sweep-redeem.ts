/**
 * sweep-redeem.ts — recover positions the bot's own journal has no record of.
 *
 * WHY THIS EXISTS
 * ----------------
 * `maybeClaim`/`claimSettled` in ec-core already redeem independent of the
 * journal: they read `settledMarkets()` from the indexer, then check your
 * ACTUAL on-chain outcome-token balance via `getOutcomeBalance` before
 * deciding what's claimable. They don't consult `position`/`enteredMarkets`
 * at all. So the two orphaned fills from the `price is not defined` bug
 * should get swept on the bot's normal claim cycle once those markets
 * settle and the indexer marks them settled.
 *
 * This script exists for the two gaps that leaves:
 *   1. You want to verify RIGHT NOW rather than wait for the next auto-claim
 *      tick / trust indexer latency.
 *   2. `settledMarkets(ctx, scan)` only looks at the most recent `scan`
 *      markets (default 25) — if a lot has traded since, or the indexer is
 *      behind, your two markets might fall outside that window. This script
 *      lets you pass their market IDs explicitly so it checks THOSE markets'
 *      on-chain state directly, no indexer list involved.
 *
 * USAGE
 * -----
 *   # Explicit market IDs (safest — use this for the two known orphaned fills)
 *   npx tsx sweep-redeem.ts --market 0xabc... --market 0xdef...
 *
 *   # Or scan the last N settled markets from the indexer (like claimSettled,
 *   # but reported here without the AUTO_CLAIM_INTERVAL_MS throttle)
 *   npx tsx sweep-redeem.ts --scan 100
 *
 *   # Dry run (default) just reports what it WOULD redeem and does nothing.
 *   # Add --live to actually send the redeem transactions.
 *   npx tsx sweep-redeem.ts --market 0xabc... --live
 *
 * Uses the same DRY_RUN/PRIVATE_KEY env wiring as the bots — --live still
 * requires a funded PRIVATE_KEY, same as any other trading script here.
 */

import {
  createExchange,
  loadConfig,
  redeemHoldings,
  type EcContext,
} from "@dreamdex-bot-kit/ec-core";
import { settledMarkets } from "@dreamdex-bot-kit/ec-core"; 
import type { MarketOnchain, UnifiedMarket } from "@somnia-chain/markets-sdk";
import type { Hex } from "viem";

const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);

interface Args {
  marketIds: string[];
  scan: number;
  live: boolean;
}

function parseArgs(argv: string[]): Args {
  const marketIds: string[] = [];
  let scan = 25;
  let live = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--market") marketIds.push(argv[++i]);
    else if (a === "--scan") scan = Number(argv[++i]);
    else if (a === "--live") live = true;
  }
  return { marketIds, scan, live };
}

/**
 * Check one market's on-chain state directly and redeem if the wallet holds
 * a claimable outcome. Bypasses `position`/journal entirely — this reads the
 * chain, nothing else.
 */
async function checkAndRedeemMarket(
  ctx: EcContext,
  marketId: string,
  symbolHint?: string
): Promise<{ symbol: string; redeemed: boolean; note: string }> {
  const addr = ctx.exchange.walletAddress;
  if (!addr) {
    return { symbol: symbolHint ?? marketId, redeemed: false, note: "no wallet/signer configured" };
  }

  const onchain: MarketOnchain | null = await ctx.exchange.client
    .getMarketOnchain(marketId as Hex)
    .catch((e: Error) => {
      log(`${marketId}: failed to read on-chain state — ${e.message}`);
      return null;
    });
  if (!onchain) {
    return { symbol: symbolHint ?? marketId, redeemed: false, note: "could not read on-chain market state" };
  }

  const symbol = symbolHint ?? marketId;

  if (!onchain.isResolved && !onchain.isVoided) {
    return { symbol, redeemed: false, note: "not settled yet (still trading/locked)" };
  }

  const held = {
    yes: await ctx.exchange.client.getOutcomeBalance({
      outcomeToken: onchain.outcomeToken,
      account: addr,
      id: onchain.yesId,
    }),
    no: await ctx.exchange.client.getOutcomeBalance({
      outcomeToken: onchain.outcomeToken,
      account: addr,
      id: onchain.noId,
    }),
  };

  log(
    `${symbol}: resolved=${onchain.isResolved} voided=${onchain.isVoided} ` +
      `winningOutcome=${onchain.isVoided ? "n/a (voided)" : onchain.winningOutcome} ` +
      `holding YES=${held.yes} NO=${held.no}`
  );

  if (held.yes === 0n && held.no === 0n) {
    return { symbol, redeemed: false, note: "no balance held — nothing to redeem (already claimed, or never filled here)" };
  }

  // Build the minimal UnifiedMarket shape redeemHoldings/settlementFeeBps need.
  const market = {
    symbol,
    info: { marketType: "BINARY", marketId },
  } as unknown as UnifiedMarket;

  const redeemed = await redeemHoldings(ctx, market, onchain, held);
  return {
    symbol,
    redeemed,
    note: redeemed
      ? "redeemed"
      : ctx.config.dryRun
        ? "dry-run — would redeem (see DRY log line above)"
        : "nothing claimable (already settled/claimed, or holding the losing side)",
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // --live means "actually send redeem transactions" — that's controlled by
  // ctx.config.dryRun (sourced from the DRY_RUN env var via loadConfig()),
  // NOT by withSigner. withSigner just means "read PRIVATE_KEY and expose a
  // wallet address" — we need that unconditionally, even in dry-run, or we
  // can't read on-chain balances at all (which is what was happening above:
  // wallet=(none) because withSigner was tied to --live).
  //
  // Set this before loadConfig()/createExchange() run so it's picked up.
  if (args.live) process.env.DRY_RUN = "false";

  const ctx = createExchange({ withSigner: true });

  if (!ctx.exchange.walletAddress) {
    log(
      "ERROR: no wallet address available even with withSigner:true. " +
        "Check that PRIVATE_KEY is set in your env (same variable the bots use)."
    );
    process.exit(1);
  }

  if (args.live && ctx.config.dryRun) {
    // Something in config still forced dry-run even after overriding DRY_RUN
    // above (e.g. a hardcoded override elsewhere in your config loader) —
    // surface that loudly instead of silently no-opping on --live.
    log(
      "WARNING: --live was passed but ctx.config.dryRun is still true. " +
        "Nothing will be redeemed. Check for another DRY_RUN override in your config."
    );
  }
  log(`sweep-redeem starting · dryRun=${ctx.config.dryRun} · wallet=${ctx.exchange.walletAddress ?? "(none)"}`);

  const results: { symbol: string; redeemed: boolean; note: string }[] = [];

  if (args.marketIds.length > 0) {
    log(`checking ${args.marketIds.length} explicit market id(s)`);
    for (const id of args.marketIds) {
      results.push(await checkAndRedeemMarket(ctx, id));
    }
  } else {
    log(`no --market ids given — scanning the last ${args.scan} settled market(s) from the indexer`);
    const settled = await settledMarkets(ctx, args.scan);
    if (settled.length === 0) {
      log("indexer returned no settled markets in that window.");
    }
    for (const row of settled) {
      results.push(await checkAndRedeemMarket(ctx, row.marketId, row.symbol));
    }
  }

  const redeemedCount = results.filter((r) => r.redeemed).length;
  log("---- summary ----");
  for (const r of results) {
    log(`${r.symbol}: ${r.note}`);
  }
  log(`${redeemedCount} market(s) actually redeemed${ctx.config.dryRun ? " (dry-run — 0 expected)" : ""}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);