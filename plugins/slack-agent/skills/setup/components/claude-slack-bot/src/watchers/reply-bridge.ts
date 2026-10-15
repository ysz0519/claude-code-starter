import type { App } from "@slack/bolt";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { postApprovalRequest } from "../approval";

/**
 * File-bridge between the external launchd `slack-reply` skill (separate process)
 * and this long-running bot (which owns the in-memory `pending` approval store and
 * the Socket Mode `approve_reply_*` action handlers).
 *
 * Flow: the skill writes a request JSON via atomic write (`<name>.json.tmp` ->
 * rename to `<name>.json`). This watcher CLAIMS the file by renaming it into
 * `processing/` BEFORE posting (rename-lock), then posts a buttoned DM via
 * `postApprovalRequest()` (which registers `pending` so the buttons resolve), then
 * deletes the claimed file.
 *
 * Idempotency: the top-level scan only reads `requests/*.json`. Because a file is
 * moved out of the scan path before any Slack call, a crash anywhere in the post
 * step cannot cause a duplicate approval DM on restart — the worst case is one
 * request stranded in `processing/` (under-deliver, logged), which is strictly
 * safer than double-posting a reply suggestion.
 *
 * Security: this bridge is slack-only. `sourceType` from the request is ignored and
 * forced to "slack"; gmail/gchat are never created here.
 */

const STATE_DIR = path.join(os.homedir(), ".claude/state/slack-reply-bridge");
const REQUESTS_DIR = path.join(STATE_DIR, "requests");
const PROCESSING_DIR = path.join(REQUESTS_DIR, "processing");
const FAILED_DIR = path.join(REQUESTS_DIR, "failed");
const POLL_INTERVAL_MS = 4000;
// Drop requests older than this (mtime) instead of posting stale suggestions.
// Kept in sync with the bot's APPROVAL_TTL_MS (30 min) semantics.
const STALE_MS = 30 * 60 * 1000;

interface BridgeRequest {
  channel?: string;
  threadTs?: string;
  senderName?: string;
  contextLabel?: string;
  originalExcerpt?: string;
  replyTexts?: string[];
}

function ensureDirs(): void {
  fs.mkdirSync(REQUESTS_DIR, { recursive: true });
  fs.mkdirSync(PROCESSING_DIR, { recursive: true });
  fs.mkdirSync(FAILED_DIR, { recursive: true });
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Move an absolute file path into failed/ (best effort, never throws). */
function moveToFailed(absPath: string): void {
  try {
    fs.renameSync(absPath, path.join(FAILED_DIR, `${Date.now()}_${path.basename(absPath)}`));
  } catch {
    try { fs.rmSync(absPath, { force: true }); } catch { /* ignore */ }
  }
}

async function processFile(app: App, file: string): Promise<void> {
  const src = path.join(REQUESTS_DIR, file);

  // Staleness: skip requests older than STALE_MS (e.g. queued while bot was down for hours).
  let stat: fs.Stats;
  try {
    stat = fs.statSync(src);
  } catch (err) {
    if (isEnoent(err)) return; // claimed/removed by an earlier iteration
    console.error(`[reply-bridge] stat failed (${file}): ${err}`);
    return;
  }
  if (Date.now() - stat.mtimeMs > STALE_MS) {
    console.warn(`[reply-bridge] stale request dropped (${file}, age=${Math.round((Date.now() - stat.mtimeMs) / 1000)}s)`);
    moveToFailed(src);
    return;
  }

  // Claim the file by moving it out of the scan path BEFORE any Slack call.
  const claimed = path.join(PROCESSING_DIR, `${Date.now()}_${file}`);
  try {
    fs.renameSync(src, claimed);
  } catch (err) {
    if (isEnoent(err)) return; // already claimed
    console.error(`[reply-bridge] claim rename failed (${file}): ${err}`);
    return;
  }

  let req: BridgeRequest;
  try {
    req = JSON.parse(fs.readFileSync(claimed, "utf8")) as BridgeRequest;
  } catch (err) {
    console.error(`[reply-bridge] read/parse failed (${file}): ${err}`);
    moveToFailed(claimed);
    return;
  }

  if (
    !req.channel ||
    !req.threadTs ||
    !Array.isArray(req.replyTexts) ||
    req.replyTexts.length === 0
  ) {
    console.error(`[reply-bridge] invalid request (need channel/threadTs/replyTexts): ${file}`);
    moveToFailed(claimed);
    return;
  }

  try {
    await postApprovalRequest(app, {
      sourceType: "slack", // bridge is slack-only; never trust request-provided sourceType
      replyTexts: req.replyTexts.slice(0, 4),
      channel: req.channel,
      threadTs: req.threadTs,
      senderName: req.senderName ?? "unknown",
      originalExcerpt: req.originalExcerpt ?? "",
      contextLabel: req.contextLabel ?? "Slack",
    });
    fs.rmSync(claimed, { force: true });
    console.log(`[reply-bridge] posted approval from ${file}`);
  } catch (err) {
    // Do NOT retry from the scan path (file is already claimed) — moving to failed/
    // avoids both a retry loop and any double-post risk.
    console.error(`[reply-bridge] postApprovalRequest failed (${file}): ${err}`);
    moveToFailed(claimed);
  }
}

/**
 * Start the bridge watcher. Drains pre-existing top-level requests on startup so
 * that requests queued while the bot was down still get posted (subject to the
 * staleness check). Files stranded in processing/ from a prior crash are reported
 * but NOT auto-reposted (avoids duplicate suggestions).
 */
export function setupReplyBridge(app: App): void {
  ensureDirs();

  try {
    const stranded = fs.readdirSync(PROCESSING_DIR).filter((f) => f.endsWith(".json"));
    if (stranded.length > 0) {
      console.warn(`[reply-bridge] ${stranded.length} request(s) stranded in processing/ (not auto-reposted): ${stranded.join(", ")}`);
    }
  } catch { /* ignore */ }

  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const files = fs
        .readdirSync(REQUESTS_DIR, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith(".json"))
        .map((d) => d.name);
      for (const f of files) {
        await processFile(app, f);
      }
    } catch (err) {
      console.error(`[reply-bridge] tick error: ${err}`);
    } finally {
      running = false;
    }
  };

  setInterval(tick, POLL_INTERVAL_MS);
  void tick(); // initial drain
  console.log(`[reply-bridge] watching ${REQUESTS_DIR} (every ${POLL_INTERVAL_MS}ms)`);
}
