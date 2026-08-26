/**
 * Renders a self-contained stat-card image for signal posts.
 * Self-contained fonts ensure 1:1 rendering parity across all server environments.
 */
import sharp from "sharp";
import { formatTimeLeft, type Stats } from "./social-format.js";
import { getEmbeddedFontFaceCss } from "./embedded-fonts.js";

// Design Tokens 
const COLORS = {
  bg: "#0B0E14",
  cardBg: "#12151C",
  border: "#1E2530",
  textPrimary: "#E4E7EC",
  textMuted: "#7C8798",
  green: "#16C784",
  greenBg: "rgba(22, 199, 132, 0.12)",
  red: "#EA3943",
  redBg: "rgba(234, 57, 67, 0.12)",
  accent: "#E8A33D",
};

export interface CardOpts {
  botName: string;
  asset: string;
  window: string;
  signal: "UP" | "DOWN";
  edge: number;
  expiryMs: number | null;
  now: number;
  reason: string;
  dryRun: boolean;
  stats: Stats;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function truncateText(str: string, maxLen: number): string {
  return str.length > maxLen ? `${str.slice(0, maxLen - 1)}…` : str;
}

/**
 * Guards against a missing/partial stats object (e.g. right after a DB wipe,
 * before any settlements exist). Without this, `o.stats.winRate` etc. throw
 * a TypeError inside buildSvg, generateSignalCard's promise rejects, and
 * that failure can surface as "nothing posted" rather than a visible error.
 */
function normalizeStats(stats: Stats | null | undefined): Stats {
  return {
    winRate: stats?.winRate ?? null,
    totalPnl: stats?.totalPnl ?? 0,
    settledCount: stats?.settledCount ?? 0,
  };
}

/** Generates a normalized SVG path for signal trend visualization */
function renderSparkline(isUp: boolean): string {
  const points = isUp
    ? [[0, 70], [50, 62], [100, 68], [150, 42], [200, 48], [250, 20], [300, 28], [350, 8]]
    : [[0, 8], [50, 16], [100, 10], [150, 36], [200, 28], [250, 58], [300, 50], [350, 72]];

  return points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${y}`).join(" ");
}

/**
 * Draws the up/down indicator as a vector polygon rather than a unicode
 * glyph (▲/▼). Neither embedded IBM Plex weight includes those codepoints,
 * and since the SVG only carries its own @font-face data (no OS fallback
 * fonts are relied upon by design — see embedded-fonts.ts), a text glyph
 * for the arrow would render blank. `cx`/`cy` is the triangle's centroid;
 * `size` is roughly the cap-height it should visually match at this weight.
 */
function renderTriangle(cx: number, cy: number, size: number, isUp: boolean, fill: string): string {
  const h = size;
  const w = size * 1.05;
  const points = isUp
    ? [[cx, cy - h / 2], [cx - w / 2, cy + h / 2], [cx + w / 2, cy + h / 2]]
    : [[cx, cy + h / 2], [cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2]];
  return `<polygon points="${points.map(([x, y]) => `${x},${y}`).join(" ")}" fill="${fill}"/>`;
}

function buildSvg(o: CardOpts): string {
  const isUp = o.signal === "UP";
  const accentColor = isUp ? COLORS.green : COLORS.red;
  const accentBg = isUp ? COLORS.greenBg : COLORS.redBg;

  const stats = normalizeStats(o.stats);

  const wrStr = stats.winRate === null ? "N/A" : `${(stats.winRate * 100).toFixed(1)}%`;
  const pnlSign = stats.totalPnl >= 0 ? "+" : "";
  const pnlStr = `${pnlSign}${stats.totalPnl.toFixed(2)}`;
  const pnlColor = stats.totalPnl >= 0 ? COLORS.green : COLORS.red;
  const edgeStr = `+${(o.edge * 100).toFixed(1)}%`;
  const timeLeft = formatTimeLeft(o.expiryMs, o.now);
  const cleanReason = escapeXml(truncateText(o.reason ?? "", 110));
  const botName = escapeXml((o.botName ?? "").toUpperCase());
  const asset = escapeXml(o.asset ?? "");
  const windowLabel = escapeXml(o.window ?? "");

  const heroTextX = 80;
  const heroBaselineY = 125;
  const heroTriangleCx = 30;
  const heroTriangleCy = heroBaselineY - 34;
  const heroTriangleSize = 46;

  return `
<svg viewBox="0 0 1200 630" width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>
      ${getEmbeddedFontFaceCss()}
      .mono { font-family: 'IBM Plex Mono', monospace; font-variant-numeric: tabular-nums; }
      .sans { font-family: 'IBM Plex Sans', sans-serif; }
    </style>

    <!-- Fading Gradient for Background Area Chart -->
    <linearGradient id="chartBgGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${accentColor}" stop-opacity="0.25"/>
      <stop offset="80%" stop-color="${accentColor}" stop-opacity="0.03"/>
      <stop offset="100%" stop-color="${accentColor}" stop-opacity="0.0"/>
    </linearGradient>

    <!-- Horizontal Fade Mask to smooth edges out on the sides -->
    <linearGradient id="chartMaskGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#000" stop-opacity="0.1"/>
      <stop offset="30%" stop-color="#000" stop-opacity="1"/>
      <stop offset="80%" stop-color="#000" stop-opacity="1"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.2"/>
    </linearGradient>

    <mask id="chartMask">
      <rect x="0" y="0" width="1200" height="630" fill="url(#chartMaskGrad)"/>
    </mask>
  </defs>

  <!-- Canvas Background -->
  <rect width="1200" height="630" fill="${COLORS.bg}"/>

  <!-- Main Container Card -->
  <rect x="40" y="40" width="1120" height="550" rx="16" fill="${COLORS.cardBg}" stroke="${COLORS.border}" stroke-width="1.5"/>

  <!-- Smooth Background Area Chart Layer (Behind Content) -->
  <g mask="url(#chartMask)" transform="translate(400, 100) scale(2.0, 2.2)" opacity="0.85">
    <path d="${renderSparkline(isUp)} L 350,120 L 0,120 Z" fill="url(#chartBgGrad)"/>
    <path d="${renderSparkline(isUp)}" fill="none" stroke="${accentColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.6"/>
  </g>

  <!-- Top Header Bar -->
  <g transform="translate(80, 85)">
    <circle cx="8" cy="14" r="6" fill="${COLORS.green}"/>
    <text x="28" y="20" class="mono" font-size="18" font-weight="600" fill="${COLORS.textPrimary}" letter-spacing="1.5">
      ${botName} ${o.dryRun ? '<tspan fill="' + COLORS.textMuted + '"></tspan>' : ''}
    </text>

    <!-- Signal Badge -->
    <g transform="translate(880, -8)">
      <rect x="0" y="0" width="120" height="36" rx="6" fill="${accentBg}" stroke="${accentColor}" stroke-width="1.5"/>
      <text x="60" y="23" text-anchor="middle" class="mono" font-size="13" font-weight="700" fill="${accentColor}" letter-spacing="2">SIGNAL</text>
    </g>
  </g>

  <line x1="80" y1="125" x2="1120" y2="125" stroke="${COLORS.border}" stroke-width="1"/>

  <!-- Main Hero Section (In Front of Chart) -->
  <g transform="translate(80, 165)">
    <text x="0" y="24" class="sans" font-size="20" font-weight="500" fill="${COLORS.textMuted}" letter-spacing="0.5">
      ${asset} <tspan fill="${COLORS.border}">|</tspan> ${windowLabel} WINDOW
    </text>

    <!-- Signal Callout -->
    ${renderTriangle(heroTriangleCx, heroTriangleCy, heroTriangleSize, isUp, accentColor)}
    <text x="${heroTextX}" y="${heroBaselineY}" class="mono" font-size="96" font-weight="700" fill="${accentColor}" letter-spacing="-2">
      ${o.signal}
    </text>

    <!-- Key Metrics Row -->
    <g transform="translate(0, 160)">
      <!-- Edge Card -->
      <rect x="0" y="0" width="220" height="72" rx="8" fill="${COLORS.bg}" stroke="${COLORS.border}" stroke-width="1"/>
      <text x="20" y="28" class="sans" font-size="11" font-weight="600" fill="${COLORS.textMuted}" letter-spacing="1">EDGE</text>
      <text x="20" y="56" class="mono" font-size="26" font-weight="700" fill="${COLORS.textPrimary}">${edgeStr}</text>

      <!-- Time Remaining Card -->
      <rect x="240" y="0" width="240" height="72" rx="8" fill="${COLORS.bg}" stroke="${COLORS.border}" stroke-width="1"/>
      <text x="260" y="28" class="sans" font-size="11" font-weight="600" fill="${COLORS.textMuted}" letter-spacing="1">EXPIRATION</text>
      <text x="260" y="56" class="mono" font-size="26" font-weight="700" fill="${COLORS.textPrimary}">${escapeXml(timeLeft)}</text>
    </g>
  </g>

  <!-- Execution Reasoning Log -->
  <g transform="translate(80, 425)">
    <rect x="0" y="0" width="1040" height="44" rx="6" fill="${COLORS.bg}" stroke="${COLORS.border}" stroke-width="1"/>
    <text x="16" y="26" class="sans" font-size="14" fill="${COLORS.textMuted}">
      <tspan font-weight="600" fill="${COLORS.accent}">STRATEGY LOG:</tspan> ${cleanReason}
    </text>
  </g>

  <!-- Bottom Track Record & Social Link Footer -->
  <g transform="translate(80, 510)">
    <line x1="0" y1="-10" x2="1040" y2="-10" stroke="${COLORS.border}" stroke-width="1"/>

    <text x="0" y="16" class="sans" font-size="11" font-weight="600" fill="${COLORS.textMuted}" letter-spacing="1">HISTORICAL WIN RATE</text>
    <text x="0" y="44" class="mono" font-size="24" font-weight="700" fill="${COLORS.textPrimary}">${wrStr}</text>

    <text x="320" y="16" class="sans" font-size="11" font-weight="600" fill="${COLORS.textMuted}" letter-spacing="1">SETTLED TRADES</text>
    <text x="320" y="44" class="mono" font-size="24" font-weight="700" fill="${COLORS.textPrimary}">${stats.settledCount}</text>

    <text x="640" y="16" class="sans" font-size="11" font-weight="600" fill="${COLORS.textMuted}" letter-spacing="1">CUMULATIVE PNL</text>
    <text x="640" y="44" class="mono" font-size="24" font-weight="700" fill="${pnlColor}">${pnlStr}</text>

    <!-- Channel Link Replacement -->
    <text x="1040" y="32" text-anchor="end" class="mono" font-size="14" font-weight="600" fill="${COLORS.accent}">
      t.me/binal_bot_signals
    </text>
  </g>
</svg>`.trim();
}

/**
 * Rasterizes the stat card into a high-res PNG Buffer for distribution.
 */
export async function generateSignalCard(o: CardOpts): Promise<Buffer> {
  const svg = buildSvg(o);
  return sharp(Buffer.from(svg))
    .png({ compressionLevel: 9, quality: 100 })
    .toBuffer();
}