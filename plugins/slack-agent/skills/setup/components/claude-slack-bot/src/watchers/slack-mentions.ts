import type { App } from "@slack/bolt";
import { config } from "../config";
import { generateReply } from "../reply-generator";
import { postApprovalRequest } from "../approval";

/**
 * Auto-join all public channels so the bot can receive message events.
 * Private channels require a manual `/invite @<your-bot>`.
 */
export async function joinAllPublicChannels(app: App): Promise<void> {
  try {
    let cursor: string | undefined;
    let joined = 0;
    let alreadyIn = 0;

    do {
      const result = await app.client.conversations.list({
        types: "public_channel",
        exclude_archived: true,
        limit: 200,
        cursor,
      });

      for (const ch of result.channels ?? []) {
        if (ch.is_member) {
          alreadyIn++;
          continue;
        }
        try {
          await app.client.conversations.join({ channel: ch.id! });
          joined++;
        } catch (err) {
          // Some channels may restrict joining
          console.warn(`[slack-watcher] Could not join #${ch.name}: ${err}`);
        }
      }

      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);

    console.log(`[slack-watcher] Channel join: ${joined} new, ${alreadyIn} already member`);
  } catch (err) {
    console.error(`[slack-watcher] Failed to list/join channels: ${err}`);
  }
}

/**
 * Register a message listener that detects mentions of the user
 * across all channels the bot is in.
 */
export function setupSlackMentionWatcher(app: App): void {
  const myMentionPattern = new RegExp(`<@${config.MY_USER_ID}>`);

  // Track recently processed messages to avoid duplicates
  const processed = new Set<string>();
  // Cleanup every 10 minutes
  setInterval(() => {
    if (processed.size > 1000) processed.clear();
  }, 10 * 60 * 1000);

  app.event("message", async ({ event, client }) => {
    const e = event as any;

    // Skip: bot messages, subtypes (edits, deletes, etc.), DMs (handled by existing handler)
    if (e.bot_id || e.subtype || e.channel_type === "im") return;

    const text: string = e.text ?? "";

    // Only process messages that mention the user
    if (!myMentionPattern.test(text)) return;

    // Skip if already processed
    const msgKey = `${e.channel}:${e.ts}`;
    if (processed.has(msgKey)) return;
    processed.add(msgKey);

    console.log(`[slack-watcher] Mention detected in ${e.channel} by ${e.user}`);

    try {
      // Get sender info
      const userInfo = await client.users.info({ user: e.user });
      const senderName = userInfo.user?.real_name ?? userInfo.user?.name ?? e.user;

      // Get channel info
      let channelName = e.channel;
      try {
        const chInfo = await client.conversations.info({ channel: e.channel });
        channelName = `#${(chInfo.channel as any)?.name ?? e.channel}`;
      } catch {
        // Private channel or no access - use ID
      }

      // Get conversation context (previous messages in the thread or channel)
      const contextMessages: string[] = [];
      try {
        const threadTs = e.thread_ts ?? e.ts;
        if (e.thread_ts) {
          // In a thread - get thread replies
          const replies = await client.conversations.replies({
            channel: e.channel,
            ts: e.thread_ts,
            limit: config.CONTEXT_MESSAGES + 1, // +1 because it includes the parent
          });
          for (const msg of (replies.messages ?? []).slice(-(config.CONTEXT_MESSAGES + 1), -1)) {
            const u = (msg as any).user;
            const t = (msg as any).text ?? "";
            contextMessages.push(`${u === config.MY_USER_ID ? "自分" : u}: ${cleanMentions(t)}`);
          }
        } else {
          // In channel main - get recent messages before this one
          const history = await client.conversations.history({
            channel: e.channel,
            latest: e.ts,
            limit: config.CONTEXT_MESSAGES,
            inclusive: false,
          });
          for (const msg of (history.messages ?? []).reverse()) {
            const u = (msg as any).user;
            const t = (msg as any).text ?? "";
            contextMessages.push(`${u === config.MY_USER_ID ? "自分" : u}: ${cleanMentions(t)}`);
          }
        }
      } catch (err) {
        console.warn(`[slack-watcher] Failed to get context: ${err}`);
      }

      // Generate 3 reply patterns
      const cleanedText = cleanMentions(text);
      const replyTexts = await generateReply({
        sourceType: "slack",
        senderName,
        context: contextMessages,
        newMessage: cleanedText,
        metadata: `チャネル: ${channelName}`,
      });

      // Post approval request with 3 patterns
      await postApprovalRequest(app, {
        sourceType: "slack",
        replyTexts,
        channel: e.channel,
        threadTs: e.thread_ts ?? e.ts,
        senderName,
        originalExcerpt: cleanedText,
        contextLabel: channelName,
      });
    } catch (err) {
      console.error(`[slack-watcher] Error processing mention: ${err}`);
    }
  });

  console.log("[slack-watcher] Mention watcher registered");
}

function cleanMentions(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+>/g, "")
    .replace(/<(https?:\/\/[^|>]+)\|[^>]+>/g, "$1")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .trim();
}
