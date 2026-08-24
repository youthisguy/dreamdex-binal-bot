/**
 * Collapses the verbose internal `reason` string (meant for the dashboard's
 * technical audience) into one short, public-friendly phrase for social
 * posts. Pattern-matches on the phrases the bot itself already emits rather
 * than re-deriving logic — see index.ts's `why`/`note()` call sites for the
 * source vocabulary this is built against.
 */
export function shortReason(opts: {
  momentumUsed: boolean;
  disagreement: number;
  edge: number;
}): string {
  const parts: string[] = [];
  if (opts.momentumUsed) parts.push("EMA momentum");
  if (opts.disagreement > 0.05) parts.push("book lagging fair value");
  if (parts.length === 0) parts.push("moneyness vs. strike");
  return parts.join(" + ");
}

export function formatTimeLeft(expiryMs: number | null, now: number): string {
  if (expiryMs === null) return "unknown window";
  const ms = expiryMs - now;
  if (ms <= 0) return "closing now";
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "<1m left";
  if (mins < 60) return `${mins}m left`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m left`;
}

export interface Stats {
  winRate: number | null; // null when no settled trades yet
  totalPnl: number;
  settledCount: number;
}

// NOTE: the plain-text "Copy for X" block (xCopyBlock) that used to live here
// has been removed — the Telegram post now carries inline buttons (Dashboard /
// Copy Trade) instead of a select-all-copy text block, so there's no more
// consumer for it. If a standalone X/Twitter post format is wanted later,
// re-add a dedicated formatter rather than resurrecting this one, since the
// button-based flow and a text-block flow want different content.
