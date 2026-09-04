/**
 * Fire-and-forget notifications to the copy-trade service.
 */
const copyServiceUrl = () => process.env.COPY_SERVICE_URL;

const CALL_TIMEOUT_MS = 8_000;
const SETTLE_IMMEDIATE_RETRIES = 3;
const SETTLE_RETRY_DELAYS_MS = [2_000, 5_000, 15_000];
/** Extra re-posts after first success/attempt (covers copy-service / RPC outages). */
const SETTLE_FOLLOWUP_MS = [60_000, 5 * 60_000, 15 * 60_000];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function postOnce(path: string, body: unknown): Promise<boolean> {
  const url = copyServiceUrl();
  if (!url) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);

  const secret = process.env.COPY_WEBHOOK_SECRET;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (secret) {
    headers["x-webhook-secret"] = secret;
  } else {
    console.error(
      `copy-service ${path}: COPY_WEBHOOK_SECRET not set — call will be rejected if the service requires it`,
    );
  }

  try {
    const res = await fetch(`${url}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`copy-service ${path}: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(
      `copy-service ${path}: ${(e as Error).message ?? e}`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Signal: keep fire-and-forget (time-critical). */
function post(path: string, body: unknown): void {
  void postOnce(path, body);
}

export interface CopySignal {
  id: string;
  marketId: string;
  symbol: string;
  asset: string;
  window: string;
  side: "BUY_YES" | "BUY_NO";
  price: number;
  limitPrice: number;
  pool: string;
  expiryMs: number | null;
  dryRun: boolean;
  timestamp: number;
}

export function notifyCopyService(signal: CopySignal): void {
  post("/api/signal", signal);
}

export interface CopySettlement {
  marketId: string;
  outcome: "WIN" | "LOSS" | "VOID";
  payoutPerShare: number;
  dryRun: boolean;
  /** Optional — helps vault redeem side */
  winningSide?: "BUY_YES" | "BUY_NO";
}

/**
 * Notify copy service of settlement with immediate retries + delayed follow-ups.
 * Safe to call multiple times: copy service settles remaining OPEN rows only.
 */
export function notifyCopySettlement(settlement: CopySettlement): void {
  if (!copyServiceUrl()) return;

  void (async () => {
    // Immediate attempts (same outage window)
    for (let i = 0; i < SETTLE_IMMEDIATE_RETRIES; i++) {
      const ok = await postOnce("/api/settlement", settlement);
      if (ok) {
        console.log(
          `copy-service settlement ok for ${settlement.marketId} (attempt ${i + 1})`,
        );
        break;
      }
      const delay = SETTLE_RETRY_DELAYS_MS[i] ?? 5_000;
      console.error(
        `copy-service settlement retry ${i + 1}/${SETTLE_IMMEDIATE_RETRIES} for ${settlement.marketId} in ${delay}ms`,
      );
      await sleep(delay);
    }

    // Delayed follow-ups (RPC/copy service back later)
    for (const wait of SETTLE_FOLLOWUP_MS) {
      await sleep(wait);
      const ok = await postOnce("/api/settlement", settlement);
      console.log(
        `copy-service settlement follow-up for ${settlement.marketId}: ${ok ? "ok" : "failed"} (after ${wait}ms)`,
      );
    }
  })();
}