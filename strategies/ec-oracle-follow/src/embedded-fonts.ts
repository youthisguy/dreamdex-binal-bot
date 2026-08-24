/**
 * Loads IBM Plex Mono/Sans font files bundled in the repo and exposes them
 * as base64 data URIs for inline @font-face embedding in the stat-card SVG.
 *
 * Why: sharp's SVG rasterizer (librsvg) resolves fonts via fontconfig at
 * render time, which means the container image must have the right font
 * packages installed (fonts-ibm-plex, in Debian's `contrib` component,
 * not enabled by default on node:20-bookworm-slim). Embedding the font
 * bytes directly in the SVG via @font-face removes that OS-level
 * dependency entirely — the SVG carries its own fonts, so rendering is
 * identical across any container/host regardless of what's installed.
 *
 * Fonts are read once at module load and cached in memory; there is no
 * per-request file I/O cost.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Locating assets/fonts robustly:
function findFontDir(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "assets", "fonts");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break; // hit filesystem root
    dir = parent;
  }
  throw new Error(
    `embedded-fonts: could not locate an assets/fonts directory by walking up from ${startDir}`
  );
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = findFontDir(__dirname);

function loadFontBase64(filename: string): string {
  const bytes = readFileSync(path.join(FONT_DIR, filename));
  return bytes.toString("base64");
}

function fontFace(family: string, weight: number, base64: string, format = "woff2"): string {
  return `
    @font-face {
      font-family: '${family}';
      font-weight: ${weight};
      font-style: normal;
      src: url(data:font/${format};base64,${base64}) format('${format}');
    }`;
}

// Loaded lazily and memoized so a missing/misnamed font file surfaces as a
// clear error the first time a card is rendered, not silently at import time
// with a fallback to system fonts (which is exactly the failure mode we're
// trying to eliminate).
let cachedFontFaceCss: string | null = null;

export function getEmbeddedFontFaceCss(): string {
  if (cachedFontFaceCss) return cachedFontFaceCss;

  const monoRegular = loadFontBase64("IBMPlexMono-Regular.woff2");
  const monoBold = loadFontBase64("IBMPlexMono-Bold.woff2");
  const sansRegular = loadFontBase64("IBMPlexSans-Regular.woff2");
  const sansSemiBold = loadFontBase64("IBMPlexSans-SemiBold.woff2");

  cachedFontFaceCss = [
    fontFace("IBM Plex Mono", 400, monoRegular),
    fontFace("IBM Plex Mono", 700, monoBold),
    fontFace("IBM Plex Sans", 400, sansRegular),
    fontFace("IBM Plex Sans", 600, sansSemiBold),
  ].join("\n");

  return cachedFontFaceCss;
}