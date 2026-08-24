/**
 * Combined production entrypoint for Render (or any single-service host).
 *
 * Render's free/standard services don't share a filesystem between separate
 * services — the dashboard reads decisions.jsonl off local disk, the bot
 * writes it the same way, so they MUST run in the same container. This
 * starts the HTTP server (dashboard.mjs's job, required for Render's health
 * check anyway) and spawns the trading bot as a child process, both sharing
 * this container's disk.
 *
 * The bot's own index.ts calls process.exit() on completion/error — spawning
 * it as a child process (not importing it directly) means that exit doesn't
 * take the whole service down with it. If it crashes, we restart it with
 * backoff rather than let the service go dark.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const JOURNAL_PATH = join(REPO_ROOT, "strategies/ec-oracle-follow/logs/decisions.jsonl");
const DASHBOARD_DIR = __dirname;

// Render sets PORT and expects the service to bind to it — DASHBOARD_PORT
// stays as a local-dev override, PORT takes priority when present.
const PORT = Number(process.env.PORT ?? process.env.DASHBOARD_PORT ?? 8787);
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css" };

// --- HTTP server: dashboard + journal + a plain health check -------------
const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  if (req.url === "/decisions.jsonl") {
    try {
      const data = await readFile(JOURNAL_PATH, "utf8");
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end(data);
    } catch (e) {
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
  console.log(`[prod-server] dashboard + health check on :${PORT}`);
  console.log(`[prod-server] journal: ${JOURNAL_PATH}`);
});

// --- Trading bot child process, with restart-on-crash backoff -------------
const BOT_CWD = REPO_ROOT;
let restartDelayMs = 2000;
const MAX_RESTART_DELAY_MS = 60_000;

function startBot() {
  console.log("[prod-server] starting ec-oracle-follow...");
  const child = spawn("npm", ["start", "-w", "ec-oracle-follow"], {
    cwd: BOT_CWD,
    env: process.env, // inherit Render's configured env vars (PRIVATE_KEY, TELEGRAM_*, OF_*, etc.)
    stdio: "inherit", // bot's own logs flow straight into Render's log stream
  });

  child.on("exit", (code, signal) => {
    console.error(`[prod-server] bot exited (code=${code}, signal=${signal}) — restarting in ${restartDelayMs}ms`);
    setTimeout(startBot, restartDelayMs);
    restartDelayMs = Math.min(restartDelayMs * 2, MAX_RESTART_DELAY_MS);
  });

  // A bot that's been up for a while crashing again should reset the
  // backoff — otherwise one bad patch of a long-running bot's history keeps
  // it throttled long after the underlying issue is gone.
  setTimeout(() => {
    restartDelayMs = 2000;
  }, 5 * 60_000);
}

startBot();

process.on("SIGTERM", () => {
  console.log("[prod-server] SIGTERM received, shutting down");
  server.close();
  process.exit(0);
});