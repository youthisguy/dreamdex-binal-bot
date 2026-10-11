#!/usr/bin/env node
/**
 * Removes the EXECUTION SKIPS card from the dashboard AND the code that writes
 * into it (deleting only the HTML would make render() throw on a missing
 * element, which stops the PnL chart from updating), and gives the left column
 * the sizing that keeps the CUMULATIVE PNL chart from being squeezed.
 *
 *   node patch-dashboard-remove-skips.mjs dashboard/index.html
 *
 * Works whether or not patch-dashboard-layout.mjs was already applied.
 * Exact-match edits, all or nothing. Backup goes to your temp folder (NOT next
 * to the file — the dashboard server serves that folder publicly).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const target = process.argv[2] ?? "index.html";
if (!existsSync(target)) { console.error(`not found: ${target}`); process.exit(1); }
let html = readFileSync(target, "utf8");
if (!html.includes("EXECUTION SKIPS")) { console.log("EXECUTION SKIPS already removed — nothing to do"); process.exit(0); }

// 1) the card (plain, or tagged by the layout patch)
const CARD_RE = /[ \t]*<div class="card(?: skips-card)?">\s*<div class="card-header"><h2>EXECUTION SKIPS \(LOG\)<\/h2><\/div>\s*<div class="card-body">\s*<div class="sitout-list" id="sitoutList">\s*<div class="empty-state">AWAITING DATA\.\.\.<\/div>\s*<\/div>\s*<\/div>\s*<\/div>[ \t]*\n?/;

// 2) the render code (original, or as rewritten by the layout patch)
const JS_RE = /[ \t]*const (?:sortedSkips|allSkips) = [\s\S]*?<div class="empty-state">NO SKIPS LOGGED<\/div>';[ \t]*\n?/;

// 3) sizing, unless the layout patch already added it
const needsSizing = !html.includes("pnl-card");
const CSS_ANCHOR = ".flow-chip.warn { color: var(--neg); border-color: var(--neg); background: var(--neg-bg); }";
const CSS_ADD = `
      /* ---- Left column sizing: only MARKET PULSE flexes ---- */
      .layout-column { overflow-y: auto; }
      .layout-column > .card:not(.pulse-card) { flex-shrink: 0; }
      .pulse-card { min-height: 240px; }
      .pnl-card .card-body { flex: 0 0 auto; height: 176px; }`;
const PNL_RE = /<div class="card">(\s*<div class="card-header">\s*<h2>CUMULATIVE PNL \(STL\)<\/h2>)/;

const problems = [];
if (!CARD_RE.test(html)) problems.push("EXECUTION SKIPS card markup");
if (!JS_RE.test(html)) problems.push("skips render code (sortedSkips ... NO SKIPS LOGGED)");
if (needsSizing && !html.includes(CSS_ANCHOR)) problems.push("flow-risk CSS anchor (.flow-chip.warn line)");
if (needsSizing && !PNL_RE.test(html)) problems.push("CUMULATIVE PNL card opening");
if (problems.length) { console.error("NOT patched — anchor(s) not found:\n  - " + problems.join("\n  - ")); process.exit(1); }

const backup = join(tmpdir(), `index.html.bak-${Date.now()}`);
writeFileSync(backup, html);
html = html.replace(CARD_RE, "");
html = html.replace(JS_RE, "");
html = html.replace(/^[ \t]*\.skips-card[^\n]*\n/gm, ""); // leftover rules from the layout patch
if (needsSizing) {
  html = html.replace(CSS_ANCHOR, CSS_ANCHOR + CSS_ADD);
  html = html.replace(PNL_RE, '<div class="card pnl-card">$1');
}
writeFileSync(target, html);
console.log(`patched ${target}\nbackup: ${backup}`);
