/**
 * Posts trade signals to a Telegram channel as a photo with two inline buttons 
 * — Dashboard and Copy Trade —
 * and a short HTML caption. When the market settles, instead of editing that
 * post in place, we send a NEW message that REPLIES to it (Telegram's
 * reply_to_message_id): the client shows the original signal as a tappable
 * quote above the result, so a follower can jump straight to what triggered
 * the call. 
 * 
 * Opt-in: everything here is a no-op (returns null / does nothing) unless
 * TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set, so this never affects a
 * run that hasn't configured it. Telegram failures are caught and logged,
 * never thrown — a social post failing should never interrupt trading.
 */
import { shortReason, formatTimeLeft, type Stats } from "./social-format.js";
import { generateSignalCard } from "./card.js";
export type { Stats };

const BOT_NAME = "Binal Bot";

// Read lazily, NOT captured as module-level constants at import time.  
const botToken = () => process.env.TELEGRAM_BOT_TOKEN;
const chatId = () => process.env.TELEGRAM_CHAT_ID;
const dashboardUrl = () => process.env.DASHBOARD_URL ?? "https://your-dashboard-url-here";
const dreamdexMarketBase = () => process.env.DREAMDEX_MARKET_URL ?? "https://app.dreamdex.io/event-contracts";
const apiBase = () => {
  const t = botToken();
  return t ? `https://api.telegram.org/bot${t}` : null;
};

// Node's fetch has NO default timeout. An unguarded call here can hang
// forever on a dropped connection, silently freezing the bot's entire
// sequential main loop (it awaits this before doing anything else) with no
// crash, no error, and no restart trigger — this is the "still running but
// stopped trading until redeploy" symptom. sendPhoto is the higher-risk call
// of the two (larger multipart upload, slower, more surface for a stall),
// so it gets a longer budget than the small JSON calls.
const JSON_CALL_TIMEOUT_MS = 8_000;
const PHOTO_UPLOAD_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface SignalPost {
  marketId: string;
  symbol: string;  
  asset: string;
  window: string; 
  signal: "UP" | "DOWN";
  edge: number;
  disagreement: number;
  momentumUsed: boolean;
  expiryMs: number | null;
  dryRun: boolean;
  stats: Stats;
}

 
const ASSET_PAIR: Record<string, string> = { BTC: "WBTC:USDso", ETH: "WETH:USDso" };

function copyTradeUrl(asset: string, window: string, symbol: string): string {
  const pair = ASSET_PAIR[asset] ?? `${asset}:USDso`;
  // pair/window are our own controlled constants, not user input — interpolate
  // directly. encodeURIComponent would escape the colon in "WBTC:USDso" to
  // %3A, which doesn't match the real observed URL format (literal ":").
  // symbol DOES need encoding: it contains "/" (e.g. ".../tUSDC") which must
  // become %2F or it'd be read as an extra path segment instead of the query value.
  return `${dreamdexMarketBase()}/${pair}/${window}?market=${encodeURIComponent(symbol)}`;
}

// Telegram's servers reject inline-button URLs that point at localhost or a
// private-network address ("Wrong HTTP URL") — a bare local dev DASHBOARD_URL
// fails the WHOLE sendPhoto call, keyboard and photo included, not just that
// one button. Detect that case and drop the Dashboard button instead, so
// local/dry-run testing still posts (with just Copy Trade) instead of failing
// outright. Once DASHBOARD_URL is swapped for a real public URL, this stops
// triggering and the Dashboard button comes back automatically 
function isPubliclyReachable(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    if (protocol !== "https:" && protocol !== "http:") return false;
    const h = hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local")) return false;
    if (h === "127.0.0.1" || h === "::1" || h === "0.0.0.0") return false;
    // RFC1918 private ranges + link-local — also unreachable from Telegram's servers.
    if (/^10\./.test(h)) return false;
    if (/^192\.168\./.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    if (/^169\.254\./.test(h)) return false;
    return true;
  } catch {
    return false;
  }
}

function signalKeyboard(asset: string, window: string, symbol: string): { inline_keyboard: { text: string; url: string }[][] } {
  const buttons: { text: string; url: string }[] = [];
  const dash = dashboardUrl();
  if (isPubliclyReachable(dash)) {
    buttons.push({ text: "📊 Dashboard", url: dash });
  } else {
    console.warn(`telegram: DASHBOARD_URL "${dash}" isn't publicly reachable — omitting Dashboard button`);
  }
  buttons.push({ text: "⚡ Trade", url: copyTradeUrl(asset, window, symbol) });
  return { inline_keyboard: [buttons] };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Short HTML caption — Telegram photo captions cap at 1024 chars, and most of this is now on the image itself. */
function signalCaption(p: SignalPost): string {
  const now = Date.now();
  const reason = shortReason({
    momentumUsed: p.momentumUsed,
    disagreement: p.disagreement,
    edge: p.edge,
  });

  const wr = p.stats.winRate === null 
    ? "n/a" 
    : `${(p.stats.winRate * 100).toFixed(1)}%`;

  const pnl = `${p.stats.totalPnl >= 0 ? "+" : ""}${p.stats.totalPnl.toFixed(2)}`;
  const dryTag = p.dryRun ? " <i>(dry-run)</i>" : "";
  const arrow = p.signal === "UP" ? "🟢" : "🔴";

  return [
    `${arrow} <b>${escapeHtml(p.asset)} ${escapeHtml(p.window)}</b>`,
    ``,
    `<b>${p.signal}</b>  |  edge +${(p.edge * 100).toFixed(1)}%  |  ${escapeHtml(formatTimeLeft(p.expiryMs, now))}`,
    escapeHtml(reason),
    ``,
    `<i>Track record: ${wr} WR  |  ${pnl} PnL  (n=${p.stats.settledCount})</i>`,
  ].join("\n");
}

async function tgCall(method: string, body: Record<string, unknown>): Promise<any | null> {
  const API = apiBase();
  if (!API) return null;
  try {
    const res = await fetchWithTimeout(
      `${API}/${method}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      JSON_CALL_TIMEOUT_MS,
    );
    const data = (await res.json()) as { ok: boolean; description?: string; result?: any };
    if (!data.ok) {
      console.error(`telegram ${method} failed: ${data.description ?? "unknown error"}`);
      return null;
    }
    return data.result;
  } catch (e) {
    console.error(`telegram ${method} error: ${(e as Error).message}`);
    return null;
  }
}

/** sendPhoto needs multipart/form-data since we're uploading raw bytes */
async function tgSendPhoto(opts: {
  photo: Buffer;
  caption: string;
  keyboard: unknown;
  replyToMessageId?: number;
}): Promise<any | null> {
  const API = apiBase();
  const CHAT_ID = chatId();
  if (!API || !CHAT_ID) return null;
  try {
    const form = new FormData();
    form.append("chat_id", CHAT_ID);
    form.append("caption", opts.caption);
    form.append("parse_mode", "HTML");
    form.append("reply_markup", JSON.stringify(opts.keyboard));
    if (opts.replyToMessageId) form.append("reply_to_message_id", String(opts.replyToMessageId));
    form.append("photo", new Blob([opts.photo], { type: "image/png" }), "signal.png");

    const res = await fetchWithTimeout(`${API}/sendPhoto`, { method: "POST", body: form }, PHOTO_UPLOAD_TIMEOUT_MS);
    const data = (await res.json()) as { ok: boolean; description?: string; result?: any };
    if (!data.ok) {
      console.error(`telegram sendPhoto failed: ${data.description ?? "unknown error"}`);
      return null;
    }
    return data.result;
  } catch (e) {
    console.error(`telegram sendPhoto error: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Post a new signal: generates the stat-card image, sends it with the
 * Dashboard / Copy Trade buttons. Returns the Telegram message_id to save
 * for the settlement reply later, or null if unconfigured/failed.
 */
export async function postSignal(p: SignalPost): Promise<number | null> {
  if (!apiBase() || !chatId()) return null;

  const now = Date.now();
  const reason = shortReason({ momentumUsed: p.momentumUsed, disagreement: p.disagreement, edge: p.edge });

  let photo: Buffer;
  try {
    photo = await generateSignalCard({
      botName: BOT_NAME,
      asset: p.asset,
      window: p.window,
      signal: p.signal,
      edge: p.edge,
      expiryMs: p.expiryMs,
      now,
      reason,
      dryRun: p.dryRun,
      stats: p.stats,
    });
  } catch (e) {
    console.error(`signal card render failed: ${(e as Error).message}`);
    return null;
  }

  const result = await tgSendPhoto({
    photo,
    caption: signalCaption(p),
    keyboard: signalKeyboard(p.asset, p.window, p.symbol),
  });
  return result?.message_id ?? null;
}

export interface SettlementPost {
  messageId: number; // the original signal post's message_id 
  outcome: "WIN" | "LOSS" | "VOID";
  pnl: number;
  stats: Stats;  
  original: SignalPost;  
}

/**
 * Post the settlement result as a reply to the original signal message
 * Telegram renders the original as a tappable
 * quote above this message, so followers can jump straight back to the
 * signal that triggered it.
 */
export async function postSettlementReply(s: SettlementPost): Promise<number | null> {
  const CHAT_ID = chatId();
  if (!apiBase() || !CHAT_ID) return null;

  const badge = s.outcome === "WIN" ? "✅ WIN" : s.outcome === "LOSS" ? "❌ LOSS" : "⚪ VOID";
  const pnlStr = `${s.pnl >= 0 ? "+" : ""}${s.pnl.toFixed(3)}`;
  const wr = s.stats.winRate === null ? "n/a" : `${(s.stats.winRate * 100).toFixed(1)}%`;
  const totalPnl = `${s.stats.totalPnl >= 0 ? "+" : ""}${s.stats.totalPnl.toFixed(2)}`;

  const text = [
    `<b>${escapeHtml(s.original.asset)} ${escapeHtml(s.original.window)}</b> settled`,
    ``,
    `<b>${badge}</b>  |  ${pnlStr} USDC`,
    ``,
    `<i>Track record: ${wr} WR  |  ${totalPnl} PnL  (n=${s.stats.settledCount})</i>`,
  ].join("\n");

  const result = await tgCall("sendMessage", {
    chat_id: CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_to_message_id: s.messageId,
    reply_markup: signalKeyboard(s.original.asset, s.original.window, s.original.symbol),
  });

  return result?.message_id ?? null;
}