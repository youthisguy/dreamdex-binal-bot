/**
 * Structured decision journal for the live dashboard.
 *
 * Append-only JSONL, two record types, joined by `market_id`:
 *   - "decision": every trade taken (sit-outs are covered by "cycle" summaries
 *     below, not one record per skip — see note on that tradeoff).
 *   - "settlement": written once a traded market resolves, via backfillSettlements().
 *   - "cycle": a periodic aggregate of what the loop is seeing when idle
 *     (scanned count, skip-reason breakdown) — gives the dashboard something
 *     to show for "why we're not trading" without one record per market per
 *     8-second poll, which would flood the file for little value.
 *
 * The bot is the only writer. The dashboard only reads.
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { EcContext } from "@dreamdex-bot-kit/ec-core";
import { estimatePayout, settlementFeeBps } from "@dreamdex-bot-kit/ec-core";

const JOURNAL_PATH = process.env.JOURNAL_PATH ?? "logs/decisions.jsonl";

function ensureDir(): void {
  try {
    mkdirSync(dirname(JOURNAL_PATH), { recursive: true });
  } catch {
    // already exists — fine
  }
}

function appendRecord(record: Record<string, unknown>): void {
  ensureDir();
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...record }) + "\n";
  appendFileSync(JOURNAL_PATH, line);
}

export interface DecisionRecord {
  market_id: string;
  symbol: string;
  asset: string;
  side: "BUY_YES" | "BUY_NO";
  size: number;
  price: number;
  dry_run: boolean;
  signal: "UP" | "DOWN";
  fair_prob: number;
  market_mid: number;
  edge: number;
  disagreement: number;
  momentum_r: number | null;
  momentum_used: boolean;
  reason: string;
}

export function logDecision(rec: DecisionRecord): void {
  appendRecord({
    type: "decision",
    action: rec.side === "BUY_YES" ? "TRADE_UP" : "TRADE_DOWN",
    outcome: "PENDING",
    ...rec,
  });
}

export interface CycleSummary {
  scanned: number;
  skips: Record<string, number>;
}

export function logCycleSummary(rec: CycleSummary): void {
  // Only worth writing if there's something to show — an all-zero cycle
  // (e.g. before warm-up) isn't useful signal for the dashboard.
  if (rec.scanned === 0) return;
  appendRecord({ type: "cycle", action: "SIT_OUT_SUMMARY", ...rec });
}

export interface SettlementRecord {
  market_id: string;
  outcome: "WIN" | "LOSS" | "VOID";
  pnl: number;
  settled_at: string;
}

export function logSettlement(rec: SettlementRecord): void {
  appendRecord({ type: "settlement", ...rec });
}

/** Read back every PENDING trade decision that doesn't yet have a matching settlement record. */
function pendingMarketIds(): { marketId: string; side: "BUY_YES" | "BUY_NO"; size: number; price: number }[] {
  if (!existsSync(JOURNAL_PATH)) return [];
  const lines = readFileSync(JOURNAL_PATH, "utf8").split("\n").filter((l) => l.trim());
  const decisions = new Map<string, { side: "BUY_YES" | "BUY_NO"; size: number; price: number }>();
  const settled = new Set<string>();

  for (const line of lines) {
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // tolerate a corrupted trailing line rather than crash the bot
    }
    if (rec.type === "decision" && (rec.action === "TRADE_UP" || rec.action === "TRADE_DOWN")) {
      decisions.set(rec.market_id, { side: rec.side, size: rec.size, price: rec.price });
    } else if (rec.type === "settlement") {
      settled.add(rec.market_id);
    }
  }

  return [...decisions.entries()]
    .filter(([marketId]) => !settled.has(marketId))
    .map(([marketId, d]) => ({ marketId, ...d }));
}

/**
 * Check every pending traded market for resolution and append a settlement
 * record if it's resolved/voided. Safe to call on a timer in dry-run (reads
 * only) and in live mode (reads only — this does NOT redeem funds; that's
 * still `claim.ts`'s job, called separately). Failures on one market don't
 * block the rest — an indexer hiccup shouldn't stall the whole backfill.
 */
export async function backfillSettlements(ctx: EcContext): Promise<number> {
  const pending = pendingMarketIds();
  let settledCount = 0;

  for (const p of pending) {
    try {
      const onchain = await ctx.exchange.client.getMarketOnchain(p.marketId as `0x${string}`);
      if (!onchain || !(onchain.isResolved || onchain.isVoided)) continue;

      const boughtOutcome = p.side === "BUY_YES" ? 0 : 1;
      const sizeRaw = BigInt(Math.round(p.size * 10 ** onchain.decimals));

      if (onchain.isVoided) {
        // Both sides refund at 0.5 — a wash relative to the entry price, not
        // a full loss. Record it as VOID so the dashboard doesn't count it
        // against the win rate.
        const payout = 0.5;
        const pnl = (payout - p.price) * p.size;
        logSettlement({ market_id: p.marketId, outcome: "VOID", pnl, settled_at: new Date().toISOString() });
        settledCount++;
        continue;
      }

      const feeBps = await settlementFeeBps(ctx, { info: { marketType: "BINARY", marketId: p.marketId } } as any, onchain);
      const payoutRaw = estimatePayout({ onchain, outcome: boughtOutcome as 0 | 1, amount: sizeRaw, feeBps });
      const payout = Number(payoutRaw) / 10 ** onchain.decimals;
      const won = onchain.winningOutcome === boughtOutcome;
      const pnl = payout - p.price * p.size;

      logSettlement({
        market_id: p.marketId,
        outcome: won ? "WIN" : "LOSS",
        pnl,
        settled_at: new Date().toISOString(),
      });
      settledCount++;
    } catch {
      // one market's indexer/chain call failing shouldn't stop the sweep
      continue;
    }
  }

  return settledCount;
}
