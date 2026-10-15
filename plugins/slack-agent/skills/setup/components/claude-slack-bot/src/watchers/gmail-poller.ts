import { exec } from "child_process";
import { promisify } from "util";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import type { App } from "@slack/bolt";
import { config } from "../config";
import { generateReply } from "../reply-generator";
import { postApprovalRequest } from "../approval";

const execAsync = promisify(exec);

/**
 * Skip patterns based on SKILL.md Step 2 filtering rules.
 * Covers: auto-notification senders, SaaS/SNS notifications,
 * ATS systems, Google system emails, and bulk-send prefixes.
 */

// 1. Auto-notification / no-reply senders
const SKIP_SENDER_PATTERNS: RegExp[] = [
  /noreply/i,
  /no-reply/i,
  /no_reply/i,
  /donotreply/i,
  /notification/i,
  /alert@/i,
  /mailer-daemon/i,
  /postmaster@/i,
];

// 2. Bulk / marketing sender prefixes (info@, support@, news@, marketing@)
const SKIP_SENDER_PREFIXES: RegExp[] = [
  /^info@/i,
  /^support@/i,
  /^news@/i,
  /^marketing@/i,
];

// 3. Google system emails
const SKIP_GOOGLE: RegExp[] = [
  /calendar-notification@google\.com/i,
  /drive-shares-dm-noreply@google\.com/i,
];

// 4. SNS notifications
const SKIP_SNS: RegExp[] = [
  /@linkedin\.com$/i,
  /@facebookmail\.com$/i,
  /@twitter\.com$/i,
  /@x\.com$/i,
  /@instagram\.com$/i,
];

// 5. SaaS tool notifications
const SKIP_SAAS: RegExp[] = [
  /@github\.com$/i,
  /@slack\.com$/i,
  /@notion\.so$/i,
  /@atlassian\.com$/i,
  /@jira\.com$/i,
  /@asana\.com$/i,
  /@trello\.com$/i,
  /@zoom\.us$/i,
  /@figma\.com$/i,
];

// 6. ATS (Applicant Tracking Systems) — handled by dedicated HH team
const SKIP_ATS: RegExp[] = [
  /hrmos\.co/i,
  /herp\.cloud/i,
  /talentio\.com/i,
];

// 7. Self-sent emails（配布版: .env の GMAIL_ACCOUNT から取る）
const SELF_EMAIL = config.GMAIL_ACCOUNT;

// Combine all skip patterns
const ALL_SKIP_PATTERNS: RegExp[] = [
  ...SKIP_SENDER_PATTERNS,
  ...SKIP_SENDER_PREFIXES,
  ...SKIP_GOOGLE,
  ...SKIP_SNS,
  ...SKIP_SAAS,
  ...SKIP_ATS,
];

// Track processed thread IDs to avoid duplicates (persisted to disk)
const PROCESSED_IDS_PATH = join(
  process.env.HOME ?? homedir(),
  ".claude/data/gmail-processed-ids.json"
);

/** Max age in ms for processed IDs (48 hours) */
const PROCESSED_ID_TTL_MS = 48 * 60 * 60 * 1000;

interface ProcessedEntry {
  /** Thread ID */
  id: string;
  /** Timestamp when processed (ms since epoch) */
  ts: number;
  /** Message count at the time of processing */
  msgCount?: number;
}

interface ProcessedValue {
  ts: number;
  msgCount: number;
}

function loadProcessedIds(): Map<string, ProcessedValue> {
  try {
    const raw = readFileSync(PROCESSED_IDS_PATH, "utf-8");
    const entries: ProcessedEntry[] = JSON.parse(raw);
    const now = Date.now();
    const map = new Map<string, ProcessedValue>();
    for (const e of entries) {
      // Only keep entries younger than TTL
      if (now - e.ts < PROCESSED_ID_TTL_MS) {
        map.set(e.id, { ts: e.ts, msgCount: e.msgCount ?? 0 });
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function saveProcessedIds(map: Map<string, ProcessedValue>): void {
  try {
    mkdirSync(dirname(PROCESSED_IDS_PATH), { recursive: true });
    const entries: ProcessedEntry[] = [];
    for (const [id, val] of map) {
      entries.push({ id, ts: val.ts, msgCount: val.msgCount });
    }
    writeFileSync(PROCESSED_IDS_PATH, JSON.stringify(entries), "utf-8");
  } catch (err) {
    console.error(`[gmail-poller] Failed to save processed IDs: ${err}`);
  }
}

const processedIds = loadProcessedIds();

interface GmailThread {
  id: string;
  from: string;
  subject: string;
  date: string;
  messageCount: number;
  labels: string[];
}

/**
 * Search for unread emails using gogcli.
 * Returns thread-level results (gogcli search returns threads).
 */
async function searchUnread(): Promise<GmailThread[]> {
  try {
    const cmd = `/opt/homebrew/bin/gog gmail search "to:${config.GMAIL_ACCOUNT} newer_than:2h -category:{promotions social updates forums} -from:noreply -from:no-reply -from:notification -from:newsletter -from:drive-shares-dm-noreply -from:calendar-notification -from:mailer-daemon -label:promotions -subject:招待 -subject:Invitation -subject:\\"Updated invitation\\"" --account ${config.GMAIL_ACCOUNT} --json`;
    const { stdout } = await execAsync(cmd, {
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const data = JSON.parse(stdout);
    const threads: GmailThread[] = [];

    if (data.threads && Array.isArray(data.threads)) {
      for (const t of data.threads) {
        threads.push({
          id: t.id,
          from: t.from ?? "",
          subject: t.subject ?? "(no subject)",
          date: t.date ?? "",
          messageCount: t.messageCount ?? 1,
          labels: t.labels ?? [],
        });
      }
    }

    console.log(`[gmail-poller] Search found ${threads.length} threads`);
    return threads;
  } catch (err) {
    console.error(`[gmail-poller] Search failed: ${err}`);
    if (err instanceof Error) {
      console.error(`[gmail-poller] Error details: ${err.message}`);
      if ((err as any).stderr) {
        console.error(`[gmail-poller] Stderr: ${(err as any).stderr?.slice(0, 500)}`);
      }
    }
    return [];
  }
}

/**
 * Get thread messages for context using gogcli.
 * Returns: { context, latestMessageId, snippet, latestFrom }
 * latestFrom = the From header of the most recent message (useful when thread-level from is self)
 */
async function getThreadDetails(threadId: string): Promise<{
  context: string[];
  latestMessageId: string;
  snippet: string;
  latestFrom: string;
  latestTo: string;
}> {
  try {
    const { stdout } = await execAsync(
      `/opt/homebrew/bin/gog gmail thread ${threadId} --account ${config.GMAIL_ACCOUNT} --json`,
      { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
    );

    const data = JSON.parse(stdout);
    const messages = data.thread?.messages ?? [];
    const context: string[] = [];

    // Get context from earlier messages
    const contextMsgs = messages.slice(0, -1).slice(-config.CONTEXT_MESSAGES);
    for (const msg of contextMsgs) {
      const from = extractHeader(msg.payload?.headers, "From") ?? "unknown";
      const snippet = msg.snippet ?? "";
      context.push(`${extractSenderName(from)}: ${snippet}`);
    }

    // Get the latest message ID, snippet, and sender
    const latest = messages[messages.length - 1];
    const latestMessageId = latest?.id ?? threadId;
    const snippet = latest?.snippet ?? "";
    const latestFrom = extractHeader(latest?.payload?.headers, "From") ?? "";
    const latestTo = extractHeader(latest?.payload?.headers, "To") ?? "";

    return { context, latestMessageId, snippet, latestFrom, latestTo };
  } catch (err) {
    console.warn(`[gmail-poller] Failed to get thread ${threadId}: ${err}`);
    return { context: [], latestMessageId: threadId, snippet: "", latestFrom: "", latestTo: "" };
  }
}

function extractHeader(headers: any[] | undefined, name: string): string | undefined {
  if (!Array.isArray(headers)) return undefined;
  return headers.find((h: any) => h.name?.toLowerCase() === name.toLowerCase())?.value;
}

function extractSenderName(from: string): string {
  // "\"Tanaka Taro\" <tanaka@example.com>" → "Tanaka Taro"
  const match = from.match(/^"?([^"<]+)"?\s*</);
  if (match) return match[1].trim();
  // "tanaka@example.com" → "tanaka"
  return from.split("@")[0];
}

// 8. Subject patterns to skip (calendar invitations, etc.)
const SKIP_SUBJECT_PATTERNS: RegExp[] = [
  /^招待\s*[:-]/i,          // Google Calendar invites (Japanese)
  /^招待\s*$/i,             // Google Calendar invite (subject is just "招待")
  /^更新:\s*招待/i,         // Updated calendar invite (Japanese)
  /^Invitation:/i,          // Google Calendar invites (English)
  /^Updated invitation:/i,  // Updated calendar invite (English)
  /^Accepted:/i,            // Calendar acceptance notifications
  /^Declined:/i,            // Calendar decline notifications
  /^Tentatively accepted:/i, // Calendar tentative notifications
  /^承諾:/i,                // Calendar acceptance (Japanese)
  /^辞退:/i,                // Calendar decline (Japanese)
  /^仮承諾:/i,              // Calendar tentative (Japanese)
];

function shouldSkip(from: string, subject?: string): boolean {
  // NOTE: Self-sent check is NOT done here because thread-level `from` can be
  // self even when someone else replied. Self-sent is checked after getThreadDetails
  // using the actual latest message sender.

  // Skip all known notification/automated patterns (sender-based)
  if (ALL_SKIP_PATTERNS.some((re) => re.test(from))) return true;
  // Skip calendar invitations and responses (subject-based)
  if (subject && SKIP_SUBJECT_PATTERNS.some((re) => re.test(subject))) return true;
  return false;
}

/**
 * Fetch the full body of a Gmail message using gogcli raw format + Python decode.
 * Returns the plain text body, or falls back to snippet on failure.
 */
async function fetchFullMessageBody(messageId: string): Promise<string | null> {
  try {
    const { stdout: rawJson } = await execAsync(
      `/opt/homebrew/bin/gog gmail get ${messageId} --account ${config.GMAIL_ACCOUNT} --format raw --json`,
      { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
    );

    const pythonScript = `
import json, sys, base64, email
from email import policy

data = json.loads(sys.stdin.read())
raw = data.get('message', {}).get('raw', '')
if not raw:
    sys.exit(1)
raw_bytes = base64.urlsafe_b64decode(raw + '==')
msg = email.message_from_bytes(raw_bytes, policy=policy.default)
body = msg.get_body(preferencelist=('plain', 'html'))
if body:
    content = body.get_content()
    # Limit to ~4000 chars to keep prompt reasonable
    print(content[:4000])
else:
    sys.exit(1)
`;

    const { stdout: body } = await execAsync(
      `echo ${JSON.stringify(rawJson)} | python3 -c ${JSON.stringify(pythonScript)}`,
      { timeout: 15000, maxBuffer: 5 * 1024 * 1024 }
    );

    const trimmed = body.trim();
    return trimmed || null;
  } catch (err) {
    console.warn(`[gmail-poller] Failed to fetch full body for ${messageId}: ${err}`);
    return null;
  }
}

/**
 * Run a single poll cycle.
 */
async function pollOnce(app: App): Promise<void> {
  console.log("[gmail-poller] Polling for unread emails...");

  const threads = await searchUnread();
  let newCount = 0;

  for (const thread of threads) {
    // Skip if already processed with same message count (no new replies)
    const prev = processedIds.get(thread.id);
    if (prev && prev.msgCount >= thread.messageCount) continue;
    processedIds.set(thread.id, { ts: Date.now(), msgCount: thread.messageCount });

    // Skip notification/automated emails and calendar invites
    if (shouldSkip(thread.from, thread.subject)) {
      console.log(`[gmail-poller] Skipping: ${thread.from} | ${thread.subject}`);
      continue;
    }

    // Skip category labels that slipped through search filters
    const skipLabels = ["CATEGORY_UPDATES", "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS"];
    if (skipLabels.some((l) => thread.labels.includes(l))) {
      console.log(`[gmail-poller] Skipping (label): ${thread.from} [${thread.labels.join(",")}]`);
      continue;
    }

    console.log(`[gmail-poller] Checking: ${thread.from} | ${thread.subject}`);

    try {
      // Get thread context and latest message ID
      const { context, latestMessageId, snippet, latestFrom, latestTo } = await getThreadDetails(thread.id);

      // Use actual latest message sender if thread-level from is self
      const effectiveFrom = (thread.from.includes(SELF_EMAIL) && latestFrom) ? latestFrom : thread.from;

      // If the latest message is from self (we sent it), skip — no reply needed
      if (effectiveFrom.includes(SELF_EMAIL)) {
        console.log(`[gmail-poller] Skipping (latest msg is self): ${thread.subject}`);
        continue;
      }

      // Skip if I'm only in CC, not in To
      if (!latestTo.toLowerCase().includes(SELF_EMAIL.toLowerCase())) {
        console.log(`[gmail-poller] Skipping (not in To): ${thread.subject} | To: ${latestTo.slice(0, 100)}`);
        continue;
      }

      newCount++;
      const senderName = extractSenderName(effectiveFrom);

      // Fetch full message body (fall back to snippet if fetch fails)
      const fullBody = await fetchFullMessageBody(latestMessageId);
      const messageContent = fullBody || snippet || thread.subject;

      // Generate 3 reply patterns
      const replyTexts = await generateReply({
        sourceType: "gmail",
        senderName,
        context,
        newMessage: messageContent,
        metadata: `件名: ${thread.subject}\n送信者: ${effectiveFrom}`,
      });

      // Post approval request with 3 patterns
      await postApprovalRequest(app, {
        sourceType: "gmail",
        replyTexts,
        gmailThreadId: thread.id,
        gmailMessageId: latestMessageId,
        senderName,
        originalExcerpt: `*${thread.subject}*\n${snippet || thread.subject}`,
        contextLabel: thread.subject,
      });
    } catch (err) {
      console.error(`[gmail-poller] Error processing thread ${thread.id}: ${err}`);
    }
  }

  // Persist processed IDs to disk after each poll
  saveProcessedIds(processedIds);

  console.log(`[gmail-poller] Poll complete. ${newCount} new emails processed.`);
}

/**
 * Start the Gmail polling watcher.
 */
export function setupGmailPoller(app: App): void {
  // Initial poll after 30 seconds (let the bot start up first)
  setTimeout(() => pollOnce(app), 30_000);

  // Regular polling
  setInterval(() => pollOnce(app), config.GMAIL_POLL_INTERVAL_MS);

  console.log(`[gmail-poller] Poller registered (interval: ${config.GMAIL_POLL_INTERVAL_MS / 60000} min)`);

  // Cleanup expired processed IDs periodically (every 12 hours)
  setInterval(() => {
    const now = Date.now();
    for (const [id, val] of processedIds) {
      if (now - val.ts >= PROCESSED_ID_TTL_MS) {
        processedIds.delete(id);
      }
    }
    saveProcessedIds(processedIds);
    console.log(`[gmail-poller] Cleanup: ${processedIds.size} IDs retained`);
  }, 12 * 60 * 60 * 1000);
}
