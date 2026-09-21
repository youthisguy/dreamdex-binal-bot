import { readFileSync } from "node:fs";
const recs = readFileSync(process.argv[2] ?? "logs/decisions.jsonl", "utf8")
  .split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const dec = new Map(), set = new Map();
for (const r of recs) {
  if (r.type === "decision") dec.set(r.market_id, r);      // last record per market wins
  else if (r.type === "settlement") set.set(r.market_id, r);
}

const bucket = (x, edges) => x == null ? "n/a" : edges.find((e, i) => x < (edges[i + 1] ?? Infinity)) + "+";
const tables = { volume_ratio: [0, 1.5, 2, 3, 4], delta_ratio_abs: [0, 1.3, 2, 3] };
const out = {};

for (const [id, d] of dec) {
  const s = set.get(id);
  if (!s || (s.outcome !== "WIN" && s.outcome !== "LOSS")) continue;
  const rows = {
    volume_ratio: bucket(d.volume_ratio, tables.volume_ratio),
    delta_ratio_abs: bucket(d.delta_ratio == null ? null : Math.abs(d.delta_ratio), tables.delta_ratio_abs),
    streak_override: String(d.streak_override ?? "none"),
  };
  for (const [k, b] of Object.entries(rows)) {
    const t = ((out[k] ??= {})[b] ??= { n: 0, wins: 0, pnl: 0 });
    t.n++; t.pnl += s.pnl; if (s.outcome === "WIN") t.wins++;
  }
}
for (const [k, v] of Object.entries(out)) {
  console.log(`\n${k}`);
  console.table(Object.fromEntries(Object.entries(v).map(([b, t]) =>
    [b, { n: t.n, winRate: (t.wins / t.n).toFixed(2), pnl: t.pnl.toFixed(3) }])));
}
