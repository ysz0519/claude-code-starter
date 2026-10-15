import type { App } from "@slack/bolt";
import { config } from "./config";

// ---- types ----

export type SourceType = "slack" | "gmail" | "gchat" | "discord";

export interface PendingApproval {
  id: string;
  sourceType: SourceType;
  /** 3 reply pattern candidates */
  replyTexts: string[];
  /** For Slack: channel to reply in */
  channel?: string;
  /** For Slack: thread_ts to reply to */
  threadTs?: string;
  /** For Gmail: threadId */
  gmailThreadId?: string;
  /** For Gmail: messageId to reply to */
  gmailMessageId?: string;
  /** For Google Chat: space name (e.g., spaces/AAAA) */
  gchatSpaceName?: string;
  /** For Google Chat: message name (e.g., spaces/AAAA/messages/BBBB) */
  gchatMessageName?: string;
  /** For Discord: channel ID to reply in */
  discordChannelId?: string;
  /** For Discord: message ID to reply to (referenced so the reply threads under it) */
  discordMessageId?: string;
  /** Original sender display name */
  senderName: string;
  /** Original message excerpt */
  originalExcerpt: string;
  /** Extra context (channel name, subject, etc.) */
  contextLabel: string;
  /** Timestamp when this request was created */
  createdAt: number;
}

// ---- state ----

const pendingApprovals = new Map<string, PendingApproval>();

let idCounter = 0;
function nextId(): string {
  return `approval_${Date.now()}_${++idCounter}`;
}

// Periodic cleanup of expired approvals
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pendingApprovals) {
    if (now - val.createdAt > config.APPROVAL_TTL_MS) {
      pendingApprovals.delete(key);
    }
  }
}, 5 * 60 * 1000);

// ---- public API ----

export function getPending(id: string): PendingApproval | undefined {
  const entry = pendingApprovals.get(id);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > config.APPROVAL_TTL_MS) {
    pendingApprovals.delete(id);
    return undefined;
  }
  return entry;
}

export function removePending(id: string): void {
  pendingApprovals.delete(id);
}

/**
 * Post an approval request to the user's DM with 3 reply patterns + No + Comment buttons.
 */
export async function postApprovalRequest(
  app: App,
  params: Omit<PendingApproval, "id" | "createdAt">
): Promise<string> {
  const id = nextId();
  const approval: PendingApproval = {
    ...params,
    // never expose more send-buttons than there are patterns (max 4 buttons)
    replyTexts: params.replyTexts.slice(0, 4),
    id,
    createdAt: Date.now(),
  };
  // NOTE: registered AFTER the DM is posted (below) so a postMessage failure
  // doesn't leave an unreachable pending entry lingering until TTL.

  const sourceEmojiMap: Record<SourceType, string> = { slack: "💬", gmail: "📩", gchat: "💬", discord: "🎮" };
  const sourceLabelMap: Record<SourceType, string> = { slack: "Slack", gmail: "Gmail", gchat: "Google Chat", discord: "Discord" };
  const sourceEmoji = sourceEmojiMap[params.sourceType];
  const sourceLabel = sourceLabelMap[params.sourceType];

  // Build blocks: header, original excerpt, divider, 3 reply patterns, action buttons
  const blocks: any[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${sourceEmoji} *${sourceLabel}* | ${params.contextLabel} | *${params.senderName}*`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `> ${params.originalExcerpt.slice(0, 500)}`,
      },
    },
    { type: "divider" },
  ];

  // Add each reply pattern as a numbered section (capped to 4 to match buttons)
  approval.replyTexts.forEach((text, i) => {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*返信パターン${i + 1}:*\n${text}`,
      },
    });
  });

  // Action buttons: 1 send-button per reply pattern (dynamic, up to 4) + No + Comment
  const circled = ["①", "②", "③", "④"];
  const patternButtons = approval.replyTexts.map((_, i) => ({
    type: "button",
    text: { type: "plain_text", text: `${circled[i] ?? String(i + 1)} 送信`, emoji: true },
    style: "primary",
    action_id: `approve_reply_${i + 1}`,
    value: id,
  }));

  blocks.push({
    type: "actions",
    elements: [
      ...patternButtons,
      {
        type: "button",
        text: { type: "plain_text", text: "❌ No", emoji: true },
        style: "danger",
        action_id: "reject_reply",
        value: id,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "✏️ コメント", emoji: true },
        action_id: "edit_reply",
        value: id,
      },
    ],
  });

  // Fallback text
  const fallbackText = `${sourceEmoji} ${sourceLabel} | ${params.contextLabel} | ${params.senderName}\n返信パターン1: ${params.replyTexts[0]}`;

  await app.client.chat.postMessage({
    channel: config.DM_CHANNEL_ID,
    text: fallbackText,
    blocks,
  });

  // Register pending only after the DM posted successfully (so a failed post
  // doesn't leave an unreachable entry). If postMessage threw above, we never
  // reach here and the caller handles the rejection.
  pendingApprovals.set(id, approval);

  console.log(`[approval] Posted request ${id} (${sourceLabel}: ${params.senderName})`);
  return id;
}

/**
 * Build the modal view for editing a reply.
 */
export function buildEditModal(approvalId: string, currentText: string) {
  return {
    type: "modal" as const,
    callback_id: "edit_reply_modal",
    private_metadata: approvalId,
    title: { type: "plain_text" as const, text: "返信を編集" },
    submit: { type: "plain_text" as const, text: "この内容で送信" },
    close: { type: "plain_text" as const, text: "キャンセル" },
    blocks: [
      {
        type: "input",
        block_id: "reply_block",
        label: { type: "plain_text" as const, text: "返信内容" },
        element: {
          type: "plain_text_input",
          action_id: "reply_text",
          multiline: true,
          initial_value: currentText,
        },
      },
    ],
  };
}
