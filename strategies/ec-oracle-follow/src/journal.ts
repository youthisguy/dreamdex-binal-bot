/**
 * Structured decision journal for the live dashboard and Telegram feed.
 *
 * Append-only JSONL, three record types, joined by `market_id`:
 *   - "decision": every trade taken (sit-outs are covered by "cycle" summaries
 *     below, not one record per skip — see note on that tradeoff).
 *   - "settlement": written once a traded market resolves, via backfillSettlements().
 *   - "cycle": a periodic aggregate of what the loop is seeing when idle
 *     (scanned count, skip-reason breakdown) — gives the dashboard something
 *     to show for "why we're not trading" without one record per market per
 *     8-second poll, which would flood the file for little value.
 *
 * The bot is the only writer. The dashboard only reads. Readers (dashboard
 * JS and pendingMarketIds()/computeStats() below) key decisions by market_id
 * in a Map, so the LAST decision record for a market_id wins — that's what
 * lets index.ts log once before posting to Telegram and optionally log again
 * with `telegram_message_id` filled in, without a separate "update" record type.
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { EcContext } from "@dreamdex-bot-kit/ec-core";
import { estimatePayout, settlementFeeBps } from "@dreamdex-bot-kit/ec-core";
import { postSettlementReply, type SignalPost, type Stats } from "./telegram.js";
import { withTimeout } from "./timeout.js";
import { scheduleCheckpoint } from "./checkpoint.js";

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

  // Trade events (a decision, its telegram_message_id follow-up, or a
  // settlement) are durable-backed to GitHub so they survive Render's
  // ephemeral disk across redeploys — see checkpoint.ts. Cycle summaries
  // are excluded: they're recomputed every heartbeat  
  if (record.type === "decision" || record.type === "settlement") {
    scheduleCheckpoint(String(record.type));
  }
}

export interface DecisionRecord {
  market_id: string;
  symbol: string;
  asset: string;
  window: string; // e.g. "15m", "1h" — for display, not parsed back out
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
  expiry_ms: number | null;
  telegram_message_id?: number | null;
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

interface PendingEntry {
  marketId: string;
  side: "BUY_YES" | "BUY_NO";
  size: number;
  price: number;
  asset: string;
  symbol: string;
  window: string;
  signal: "UP" | "DOWN";
  edge: number;
  disagreement: number;
  momentumUsed: boolean;
  expiryMs: number | null;
  dryRun: boolean;
  telegramMessageId: number | null;
}

function readAllRecords(): any[] {
  if (!existsSync(JOURNAL_PATH)) return [];
  return readFileSync(JOURNAL_PATH, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null; // tolerate a corrupted trailing line rather than crash the bot
      }
    })
    .filter(Boolean);
}

/** Read back every PENDING trade decision that doesn't yet have a matching settlement record. */
function pendingMarketIds(): PendingEntry[] {
  const decisions = new Map<string, PendingEntry>();
  const settled = new Set<string>();

  for (const rec of readAllRecords()) {
    if (rec.type === "decision" && (rec.action === "TRADE_UP" || rec.action === "TRADE_DOWN")) {
      decisions.set(rec.market_id, {
        marketId: rec.market_id,
        side: rec.side,
        size: rec.size,
        price: rec.price,
        asset: rec.asset,
        symbol: rec.symbol,
        window: rec.window ?? "",
        signal: rec.signal,
        edge: rec.edge,
        disagreement: rec.disagreement,
        momentumUsed: rec.momentum_used,
        expiryMs: rec.expiry_ms ?? null,
        dryRun: rec.dry_run,
        telegramMessageId: rec.telegram_message_id ?? null,
      });
    } else if (rec.type === "settlement") {
      settled.add(rec.market_id);
    }
  }

  return [...decisions.values()].filter((d) => !settled.has(d.marketId));
}

/**
 * Win rate + total PnL over settled (WIN/LOSS only — VOID is excluded, same
 * convention the dashboard uses) trades. One source of truth for both the
 * dashboard and the Telegram "track record" line, so the two never drift.
 */
export function computeStats(): Stats {
  const decisions = new Map<string, any>();
  const settlements = new Map<string, any>();

  for (const rec of readAllRecords()) {
    if (rec.type === "decision" && (rec.action === "TRADE_UP" || rec.action === "TRADE_DOWN")) {
      decisions.set(rec.market_id, rec);
    } else if (rec.type === "settlement") {
      settlements.set(rec.market_id, rec);
    }
  }

  let wins = 0,
    settledCount = 0,
    totalPnl = 0;
  for (const [marketId] of decisions) {
    const s = settlements.get(marketId);
    if (!s || (s.outcome !== "WIN" && s.outcome !== "LOSS")) continue;
    settledCount++;
    totalPnl += s.pnl;
    if (s.outcome === "WIN") wins++;
  }

  return { winRate: settledCount ? wins / settledCount : null, totalPnl, settledCount };
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
      const onchain = await withTimeout(
        ctx.exchange.client.getMarketOnchain(p.marketId as `0x${string}`),
        10_000,
        `getMarketOnchain(${p.marketId})`,
      );
      if (!onchain || !(onchain.isResolved || onchain.isVoided)) continue;

      const boughtOutcome = p.side === "BUY_YES" ? 0 : 1;
      const sizeRaw = BigInt(Math.round(p.size * 10 ** onchain.decimals));

      let outcome: "WIN" | "LOSS" | "VOID";
      let pnl: number;

      if (onchain.isVoided) {
        // Both sides refund at 0.5 — a wash relative to the entry price, not
        // a full loss. Record it as VOID so the dashboard doesn't count it
        // against the win rate.
        outcome = "VOID";
        pnl = (0.5 - p.price) * p.size;
      } else {
        const feeBps = await settlementFeeBps(ctx, { info: { marketType: "BINARY", marketId: p.marketId } } as any, onchain);
        const payoutRaw = estimatePayout({ onchain, outcome: boughtOutcome as 0 | 1, amount: sizeRaw, feeBps });
        const payout = Number(payoutRaw) / 10 ** onchain.decimals;
        const won = onchain.winningOutcome === boughtOutcome;
        outcome = won ? "WIN" : "LOSS";
        pnl = payout - p.price * p.size;
      }

      logSettlement({ market_id: p.marketId, outcome, pnl, settled_at: new Date().toISOString() });
      settledCount++;

      if (p.telegramMessageId) {
        const original: SignalPost = {
          marketId: p.marketId,
          symbol: p.symbol,
          asset: p.asset,
          window: p.window,
          signal: p.signal,
          edge: p.edge,
          disagreement: p.disagreement,
          momentumUsed: p.momentumUsed,
          expiryMs: p.expiryMs,
          dryRun: p.dryRun,
          stats: computeStats(), // stats AFTER this settlement is already logged above
        };
        await postSettlementReply({ messageId: p.telegramMessageId, outcome, pnl, stats: original.stats, original }).catch(
          (e) => console.error(`telegram settlement reply failed: ${(e as Error).message}`),
        );
      }
    } catch {
      // one market's indexer/chain call failing shouldn't stop the sweep
      continue;
    }
  }

  return settledCount;
}