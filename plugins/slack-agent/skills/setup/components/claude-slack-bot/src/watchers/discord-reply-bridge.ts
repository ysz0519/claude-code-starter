import type { App } from "@slack/bolt";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { postApprovalRequest } from "../approval";

/**
 * File-bridge between the launchd `discord-reply` skill (separate Claude CLI
 * process) and this long-running bot. Mirrors `reply-bridge.ts` exactly, except
 * the source is Discord: requests carry `discordChannelId` / `discordMessageId`
 * (not Slack channel/threadTs), and the approval is posted with
 * `sourceType: "discord"` so the send buttons deliver back to Discord.
 *
 * Flow: the skill writes `<messageId>.json` (atomic). This watcher CLAIMS it by
 * renaming into `processing/` BEFORE posting, then posts a buttoned Slack DM via
 * `postApprovalRequest()` (which registers `pending` so the shared
 * `approve_reply_*` handlers resolve), then deletes the claimed file.
 *
 * Idempotency: a file is moved out of the scan path before any Slack call, so a
 * crash cannot double-post on restart (worst case: one request stranded in
 * processing/, logged, not auto-reposted).
 */

const STATE_DIR = path.join(os.homedir(), ".claude/state/discord-reply-bridge");
const REQUESTS_DIR = path.join(STATE_DIR, "requests");
const PROCESSING_DIR = path.join(REQUESTS_DIR, "processing");
const FAILED_DIR = path.join(REQUESTS_DIR, "failed");
const POLL_INTERVAL_MS = 4000;
// Drop requests older than this (mtime) instead of posting stale suggestions.
const STALE_MS = 30 * 60 * 1000;

interface BridgeRequest {
  discordChannelId?: string;
  discordMessageId?: string;
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

function moveToFailed(absPath: string): void {
  try {
    fs.renameSync(absPath, path.join(FAILED_DIR, `${Date.now()}_${path.basename(absPath)}`));
  } catch {
    try {
      fs.rmSync(absPath, { force: true });
    } catch {
      /* ignore */
    }
  }
}

async function processFile(app: App, file: string): Promise<void> {
  const src = path.join(REQUESTS_DIR, file);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(src);
  } catch (err) {
    if (isEnoent(err)) return;
    console.error(`[discord-reply-bridge] stat failed (${file}): ${err}`);
    return;
  }
  if (Date.now() - stat.mtimeMs > STALE_MS) {
    console.warn(
      `[discord-reply-bridge] stale request dropped (${file}, age=${Math.round((Date.now() - stat.mtimeMs) / 1000)}s)`
    );
    moveToFailed(src);
    return;
  }

  const claimed = path.join(PROCESSING_DIR, `${Date.now()}_${file}`);
  try {
    fs.renameSync(src, claimed);
  } catch (err) {
    if (isEnoent(err)) return;
    console.error(`[discord-reply-bridge] claim rename failed (${file}): ${err}`);
    return;
  }

  let req: BridgeRequest;
  try {
    req = JSON.parse(fs.readFileSync(claimed, "utf8")) as BridgeRequest;
  } catch (err) {
    console.error(`[discord-reply-bridge] read/parse failed (${file}): ${err}`);
    moveToFailed(claimed);
    return;
  }

  if (
    !req.discordChannelId ||
    !req.discordMessageId ||
    !Array.isArray(req.replyTexts) ||
    req.replyTexts.length === 0
  ) {
    console.error(
      `[discord-reply-bridge] invalid request (need discordChannelId/discordMessageId/replyTexts): ${file}`
    );
    moveToFailed(claimed);
    return;
  }

  try {
    await postApprovalRequest(app, {
      sourceType: "discord",
      replyTexts: req.replyTexts.slice(0, 4),
      discordChannelId: req.discordChannelId,
      discordMessageId: req.discordMessageId,
      senderName: req.senderName ?? "unknown",
      originalExcerpt: req.originalExcerpt ?? "",
      contextLabel: req.contextLabel ?? "Discord",
    });
    fs.rmSync(claimed, { force: true });
    console.log(`[discord-reply-bridge] posted approval from ${file}`);
  } catch (err) {
    console.error(`[discord-reply-bridge] postApprovalRequest failed (${file}): ${err}`);
    moveToFailed(claimed);
  }
}

export function setupDiscordReplyBridge(app: App): void {
  ensureDirs();

  try {
    const stranded = fs.readdirSync(PROCESSING_DIR).filter((f) => f.endsWith(".json"));
    if (stranded.length > 0) {
      console.warn(
        `[discord-reply-bridge] ${stranded.length} request(s) stranded in processing/ (not auto-reposted): ${stranded.join(", ")}`
      );
    }
  } catch {
    /* ignore */
  }

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
      console.error(`[discord-reply-bridge] tick error: ${err}`);
    } finally {
      running = false;
    }
  };

  setInterval(tick, POLL_INTERVAL_MS);
  void tick();
  console.log(`[discord-reply-bridge] watching ${REQUESTS_DIR} (every ${POLL_INTERVAL_MS}ms)`);
}
