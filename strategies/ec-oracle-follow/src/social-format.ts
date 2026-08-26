/**
 * Collapses the verbose internal `reason` string (meant for the dashboard's
 * technical audience) into one short, public-friendly phrase for social
 * posts.
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
  winRate: number | null; 
  totalPnl: number;
  settledCount: number;
}
 