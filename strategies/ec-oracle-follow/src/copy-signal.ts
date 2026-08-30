// * Fire-and-forget notifications to the copy-trade service. 
//  */
const copyServiceUrl = () => process.env.COPY_SERVICE_URL; // e.g. http://localhost:8788

const CALL_TIMEOUT_MS = 5_000;

function post(path: string, body: unknown): void {
  const url = copyServiceUrl();
  if (!url) return; // copy-trading not configured for this run — silent no-op

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);

  fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: controller.signal,
  })
    .catch((e) => {
      console.error(`copy-service ${path} failed: ${(e as Error).message}`);
    })
    .finally(() => clearTimeout(timer));
}

export interface CopySignal {
  id: string;
  marketId: string;
  symbol: string;
  asset: string;
  window: string;
  side: "BUY_YES" | "BUY_NO";
  price: number; // the exact price the bot itself crossed at
  /** Pool address for THIS market, from the bot's own onchain snapshot —
   *  passed through so the copy-service never has to rediscover it via
   *  ec-core (which it doesn't have access to). Pool addresses recycle
   *  across market windows, so this is only ever used for this one signal. */
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
  /** Payout per unit of shares held, e.g. if the bot's own trade held 10
   *  shares and its payout was 10, payoutPerShare = 1. Every copying
   *  user's payout is their own shares * this ratio — same market, same
   *  outcome, so the ratio is identical regardless of position size. */
  payoutPerShare: number;
  dryRun: boolean;
}

export function notifyCopySettlement(settlement: CopySettlement): void {
  post("/api/settlement", settlement);
}
