import { google, chat_v1 } from "googleapis";
import type { App } from "@slack/bolt";
import { config } from "../config";
import { getGChatAuthClient } from "../gchat-auth";
import { generateReply } from "../reply-generator";
import { postApprovalRequest } from "../approval";

// Track processed message names to avoid duplicates
const processedIds = new Set<string>();

// Cache: my own user ID in Google Chat (resolved on first poll)
let myUserId: string | null = null;

/**
 * Get the authenticated Google Chat API client.
 */
function getChatClient(): chat_v1.Chat {
  const auth = getGChatAuthClient();
  return google.chat({ version: "v1", auth });
}

/**
 * Resolve the current user's Google Chat user ID.
 * The user ID appears as "users/{userId}" in message sender fields.
 */
async function resolveMyUserId(chat: chat_v1.Chat): Promise<string> {
  if (myUserId) return myUserId;

  // List DM spaces; the current user is always a member.
  // We can extract our user ID from any space's membership.
  const { data } = await chat.spaces.list({
    filter: 'spaceType = "DIRECT_MESSAGE"',
    pageSize: 1,
  });

  const space = data.spaces?.[0];
  if (!space?.name) {
    throw new Error("[gchat-poller] No DM spaces found. Cannot resolve user ID.");
  }

  // List members of this space to find self
  const members = await chat.spaces.members.list({
    parent: space.name,
    pageSize: 10,
  });

  // In a DM there are exactly 2 members. We need to identify which one is "me".
  // The member with type USER whose name matches the OAuth user is us.
  // Since we can't directly query "me", we'll use the setup endpoint.
  // Alternative: check the user field that matches our email.
  // For now, we'll store the user ID from the first message we send or see.

  // Simpler approach: just mark myUserId when we first encounter a self-sent message
  // For initial value, leave null and filter by checking sender in messages
  console.log("[gchat-poller] User ID will be resolved from first poll cycle");
  return "";
}

/**
 * Get the lastReadTime for a space from spaceReadState API.
 */
async function getLastReadTime(chat: chat_v1.Chat, spaceName: string): Promise<string | null> {
  try {
    const spaceId = spaceName.replace("spaces/", "");
    const { data } = await chat.users.spaces.getSpaceReadState({
      name: `users/me/spaces/${spaceId}/spaceReadState`,
    });
    return data.lastReadTime ?? null;
  } catch (err) {
    // spaceReadState may not exist if the space has never been read
    console.warn(`[gchat-poller] Could not get read state for ${spaceName}: ${err}`);
    return null;
  }
}

/**
 * Update the read state (mark messages as read) after sending a reply.
 */
async function markAsRead(chat: chat_v1.Chat, spaceName: string, timestamp: string): Promise<void> {
  try {
    const spaceId = spaceName.replace("spaces/", "");
    await chat.users.spaces.updateSpaceReadState({
      name: `users/me/spaces/${spaceId}/spaceReadState`,
      updateMask: "lastReadTime",
      requestBody: {
        lastReadTime: timestamp,
      },
    });
  } catch (err) {
    console.warn(`[gchat-poller] Failed to mark as read for ${spaceName}: ${err}`);
  }
}

/**
 * Extract display name from a Google Chat message sender.
 */
function getSenderName(message: chat_v1.Schema$Message): string {
  return message.sender?.displayName ?? message.sender?.name ?? "Unknown";
}

/**
 * Check if a message was sent by the authenticated user.
 * Uses the sender.type field: HUMAN for users, BOT for bots.
 * Since we're the only human using this OAuth token, we check by email domain
 * or by comparing to previously resolved user ID.
 */
function isSelfMessage(message: chat_v1.Schema$Message): boolean {
  // If we know our user ID, compare directly
  if (myUserId && message.sender?.name === myUserId) return true;

  // Check if sender name matches our email pattern
  // sender.name format: "users/{userId}"
  // We can also check domainId or type
  const senderName = message.sender?.name ?? "";

  // Cache our user ID if this looks like it could be us
  // We rely on the fact that messages from "self" have sender.type = "HUMAN"
  // and the email in the user profile matches ours.
  // Since there's no direct way to check, we'll compare names found in DM context.

  return false;
}

/**
 * Get conversation context (previous messages) from a space.
 */
async function getConversationContext(
  chat: chat_v1.Chat,
  spaceName: string,
  beforeTime: string
): Promise<string[]> {
  try {
    const { data } = await chat.spaces.messages.list({
      parent: spaceName,
      filter: `createTime < "${beforeTime}"`,
      orderBy: "createTime desc",
      pageSize: config.CONTEXT_MESSAGES,
    });

    const messages = (data.messages ?? []).reverse();
    return messages.map((msg) => {
      const name = getSenderName(msg);
      const text = msg.text ?? "";
      return `${name}: ${text.slice(0, 200)}`;
    });
  } catch (err) {
    console.warn(`[gchat-poller] Failed to get context for ${spaceName}: ${err}`);
    return [];
  }
}

/**
 * Send a reply to a Google Chat space.
 */
export async function sendGChatReply(
  spaceName: string,
  text: string,
  threadName?: string
): Promise<void> {
  const chat = getChatClient();

  const requestBody: chat_v1.Schema$Message = { text };
  if (threadName) {
    requestBody.thread = { name: threadName };
  }

  await chat.spaces.messages.create({
    parent: spaceName,
    requestBody,
    messageReplyOption: threadName
      ? "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD"
      : undefined,
  });

  console.log(`[gchat-poller] Reply sent to ${spaceName}`);
}

/**
 * Run a single poll cycle: check all DM spaces for unread messages.
 */
async function pollOnce(app: App): Promise<void> {
  console.log("[gchat-poller] Polling for unread Google Chat DMs...");

  const chat = getChatClient();
  let newCount = 0;

  try {
    // 1. List all DM spaces
    let pageToken: string | undefined;
    const allSpaces: chat_v1.Schema$Space[] = [];

    do {
      const { data } = await chat.spaces.list({
        filter: 'spaceType = "DIRECT_MESSAGE"',
        pageSize: 100,
        pageToken,
      });
      if (data.spaces) allSpaces.push(...data.spaces);
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);

    console.log(`[gchat-poller] Found ${allSpaces.length} DM spaces`);

    // 2. Check each space for unread messages
    for (const space of allSpaces) {
      if (!space.name) continue;

      try {
        // Get last read time
        const lastReadTime = await getLastReadTime(chat, space.name);

        // Build filter for unread messages
        let filter = "";
        if (lastReadTime) {
          filter = `createTime > "${lastReadTime}"`;
        } else {
          // If no read state, only get messages from last 2 hours
          const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
          filter = `createTime > "${twoHoursAgo}"`;
        }

        // 3. List unread messages
        const { data: msgData } = await chat.spaces.messages.list({
          parent: space.name,
          filter,
          orderBy: "createTime desc",
          pageSize: 10,
        });

        const messages = msgData.messages ?? [];
        if (messages.length === 0) continue;

        // 4. Find the latest message not from self
        // Filter out messages we already processed
        const unprocessed = messages.filter(
          (msg) => msg.name && !processedIds.has(msg.name)
        );
        if (unprocessed.length === 0) continue;

        // Get the most recent unprocessed message
        const latestMsg = unprocessed[0]; // Already sorted desc by createTime
        if (!latestMsg.name || !latestMsg.text) continue;

        // Skip bot messages
        if (latestMsg.sender?.type === "BOT") {
          processedIds.add(latestMsg.name);
          continue;
        }

        // Detect self-messages by checking if sender matches our cached user ID
        // On first run, resolve myUserId by checking who is NOT the other party
        const senderName = getSenderName(latestMsg);

        // If the sender display name matches our name patterns, it's likely us
        // More reliable: check if we already have myUserId
        if (myUserId && latestMsg.sender?.name === myUserId) {
          processedIds.add(latestMsg.name);
          continue;
        }

        // Heuristic: if no myUserId yet, try to resolve it
        // In a DM, if there's a message from us, we'll learn our user ID
        if (!myUserId) {
          // Check all messages in this batch to find one with our identity
          // We'll identify self by checking the space membership
          try {
            const membersResp = await chat.spaces.members.list({
              parent: space.name,
              pageSize: 10,
            });
            const members = membersResp.data.memberships ?? [];
            // In a DM with 2 members, one is us. We can try to identify by
            // checking which member's displayName matches known patterns.
            // But the simplest: if there are messages in the batch and one
            // sender appears in multiple spaces, that's likely us.
            // For now, if senderName looks like our name, store it.
            // 配布版: 自分の表示名は .env の GCHAT_MY_DISPLAY_NAMES（カンマ区切り）で指定する。
            // 未設定なら OWNER_NAME を使う。どれにも一致しなければ解決をあきらめる（誤爆防止）。
            const myNameHints = (process.env.GCHAT_MY_DISPLAY_NAMES ?? config.OWNER_NAME)
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            for (const member of members) {
              const memberName = member.member?.name ?? "";
              const memberDisplayName = member.member?.displayName ?? "";
              if (myNameHints.some((hint) => memberDisplayName.includes(hint))) {
                myUserId = memberName;
                console.log(`[gchat-poller] Resolved my user ID: ${myUserId} (${memberDisplayName})`);
                break;
              }
            }
          } catch {
            // Best effort
          }

          // Re-check after resolution
          if (myUserId && latestMsg.sender?.name === myUserId) {
            processedIds.add(latestMsg.name);
            continue;
          }
        }

        // Mark as processed
        processedIds.add(latestMsg.name);
        newCount++;

        console.log(`[gchat-poller] New message from ${senderName} in ${space.displayName ?? space.name}: ${latestMsg.text?.slice(0, 80)}`);

        // 5. Get conversation context
        const context = await getConversationContext(
          chat,
          space.name,
          latestMsg.createTime ?? new Date().toISOString()
        );

        // 6. Generate 3 reply patterns
        const replyTexts = await generateReply({
          sourceType: "gchat",
          senderName,
          context,
          newMessage: latestMsg.text,
          metadata: `Google Chat DM: ${senderName}`,
        });

        // 7. Post approval request to Slack DM
        await postApprovalRequest(app, {
          sourceType: "gchat",
          replyTexts,
          gchatSpaceName: space.name,
          gchatMessageName: latestMsg.name,
          senderName,
          originalExcerpt: latestMsg.text.slice(0, 500),
          contextLabel: senderName,
        });
      } catch (err) {
        console.error(`[gchat-poller] Error processing space ${space.name}: ${err}`);
      }
    }
  } catch (err) {
    console.error(`[gchat-poller] Poll failed: ${err}`);
  }

  console.log(`[gchat-poller] Poll complete. ${newCount} new messages processed.`);
}

/**
 * Start the Google Chat DM polling watcher.
 */
export function setupGChatPoller(app: App): void {
  if (!config.GCHAT_ENABLED) {
    console.log("[gchat-poller] Disabled (GCHAT_ENABLED != true)");
    return;
  }

  if (!config.GCHAT_CLIENT_ID || !config.GCHAT_CLIENT_SECRET || !config.GCHAT_REFRESH_TOKEN) {
    console.warn("[gchat-poller] Missing credentials. Run `npx tsx src/gchat-auth.ts` to set up.");
    return;
  }

  // Initial poll after 45 seconds (let the bot and other pollers start first)
  setTimeout(() => pollOnce(app), 45_000);

  // Regular polling
  setInterval(() => pollOnce(app), config.GCHAT_POLL_INTERVAL_MS);

  console.log(
    `[gchat-poller] Poller registered (interval: ${config.GCHAT_POLL_INTERVAL_MS / 1000}s)`
  );

  // Cleanup processed IDs periodically
  setInterval(() => {
    if (processedIds.size > 5000) {
      processedIds.clear();
    }
  }, 12 * 60 * 60 * 1000);
}
