/**
 * Minimal static server so the dashboard can `fetch()` the journal
 * Serves two things:
 *   - /decisions.jsonl  → strategies/ec-oracle-follow/logs/decisions.jsonl
 *   - everything else   → dashboard/ (so dashboard/index.html loads at "/")
 *
 * Run alongside the bot (separate terminal, doesn't touch trading logic):
 *   node dashboard/server.mjs
 * Then open http://localhost:8787
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const JOURNAL_PATH = join(REPO_ROOT, "strategies/ec-oracle-follow/logs/decisions.jsonl");
const DASHBOARD_DIR = __dirname;
const PORT = Number(process.env.DASHBOARD_PORT ?? 8787);

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css" };

const server = createServer(async (req, res) => {
  // Same-origin by default since the dashboard is served from here too, but
  // allow cross-origin fetches in case the dashboard is ever opened from a
  // different port/host during development.
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.url === "/decisions.jsonl") {
    try {
      const data = await readFile(JOURNAL_PATH, "utf8");
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end(data);
    } catch (e) {
      // No trades yet is a valid state, not an error — empty body reads as
      // "no records" on the dashboard side rather than a fetch failure.
      if (e.code === "ENOENT") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("");
      } else {
        res.writeHead(500);
        res.end(`journal read error: ${e.message}`);
      }
    }
    return;
  }

  const path = req.url === "/" ? "/index.html" : req.url;
  try {
    const filePath = join(DASHBOARD_DIR, path);
    if (!filePath.startsWith(DASHBOARD_DIR)) throw new Error("path escape blocked");
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

server.listen(PORT, () => {
  console.log(`dashboard: http://localhost:${PORT}`);
  console.log(`journal:   ${JOURNAL_PATH}`);
});
