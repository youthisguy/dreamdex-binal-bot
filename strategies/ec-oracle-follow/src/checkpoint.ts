/**
 * Durable backup of the trade journal to GitHub, since Render's disk is
 * ephemeral: scripts/checkpoint.sh commits + pushes whatever's under
 * CHECKPOINT_PATHS (default "logs", i.e. logs/decisions.jsonl) any time
 * this process writes a real trade event, so a fresh deploy restores full
 * trade history instead of starting cold (see scripts/restore-and-start.sh,
 * the Render start command that pulls it back down before boot).
 *
 * Path resolution: `npm start -w ec-oracle-follow` runs with process.cwd()
 * set to THIS WORKSPACE (strategies/ec-oracle-follow), not the repo root —
 * so `path.resolve(process.cwd(), "scripts/checkpoint.sh")` looks in the
 * wrong place and silently fails every call. Instead we walk up from this
 * module's own file location (import.meta.url) to find the repo root that
 * actually contains scripts/checkpoint.sh — robust to whatever cwd the
 * process was launched with.
 *
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CheckpointResult {
  ok: boolean;
  output: string;
}

function checkpointConfigured(): boolean {
  return Boolean(process.env.GITHUB_REPO && process.env.GITHUB_TOKEN);
}

// Locate the repo root robustly, independent of process.cwd():
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "scripts", "checkpoint.sh"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break; // hit filesystem root
    dir = parent;
  }
  throw new Error(`could not locate scripts/checkpoint.sh by walking up from ${startDir}`);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let cachedRepoRoot: string | null = null;

function repoRoot(): string {
  if (cachedRepoRoot === null) cachedRepoRoot = findRepoRoot(__dirname);
  return cachedRepoRoot;
}

/**
 * Runs scripts/checkpoint.sh (commit + push CHECKPOINT_PATHS) and returns
 * its combined stdout/stderr. Always resolves, never throws — callers
 * decide what a failure means for them.
 */
export async function runCheckpointScript(): Promise<CheckpointResult> {
  if (!checkpointConfigured()) {
    return { ok: true, output: "checkpoint: GITHUB_REPO/GITHUB_TOKEN not set — skipping" };
  }

  let scriptPath: string;
  let cwd: string;
  try {
    cwd = repoRoot();
    scriptPath = path.join(cwd, "scripts", "checkpoint.sh");
  } catch (err) {
    // Surfaced as a normal failed result, not a thrown error — this must
    // never escape as an unhandled rejection into the caller's queue.
    return { ok: false, output: `checkpoint: ${(err as Error).message}` };
  }

  try {
    const { stdout, stderr } = await execFileAsync("bash", [scriptPath], { cwd, timeout: 60_000 });
    return { ok: true, output: (stdout + stderr).trim() };
  } catch (err: any) {
    const output = String((err?.stdout ?? "") + (err?.stderr ?? "")).trim();
    return { ok: false, output: output || (err instanceof Error ? err.message : String(err)) };
  }
}

// --- fire-and-forget entry point for hot call sites (journal.ts) ---

let queue: Promise<void> = Promise.resolve();
let pending = 0;
// A running checkpoint plus one queued-behind-it is enough: the queued run
// will pick up every write on disk at the time it fires, so a burst of
// trades doesn't need one queued job per write.
const MAX_QUEUED = 2;

/**
 * Fire-and-forget checkpoint trigger. `reason` is only for the log line.
 * Drops a trigger if one is already queued and not yet running, since the
 * queued run covers it anyway. Never awaited by callers.
 */
export function scheduleCheckpoint(reason: string): void {
  if (!checkpointConfigured()) return;
  if (pending >= MAX_QUEUED) return;
  pending++;
  queue = queue
    .then(async () => {
      const result = await runCheckpointScript();
      if (!result.ok) {
        console.error(`checkpoint (${reason}) failed: ${result.output}`);
      } else if (result.output && !result.output.includes("nothing to commit")) {
        console.log(`checkpoint (${reason}): ${result.output}`);
      }
    })
    .catch((e) => {
      // Belt-and-suspenders: runCheckpointScript() shouldn't throw, but if
      // anything upstream of it ever does, this must not become an
      // unhandled rejection that kills the process.
      console.error(`checkpoint (${reason}) unexpected error: ${(e as Error).message}`);
    })
    .finally(() => {
      pending--;
    });
}