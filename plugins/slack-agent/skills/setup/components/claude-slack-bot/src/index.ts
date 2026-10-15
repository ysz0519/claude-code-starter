import { App, LogLevel } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { exec, execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { config } from "./config";
import { runClaude, isClaudeAuthError } from "./claude";
import { getPending, removePending, buildEditModal } from "./approval";
import { setupSlackMentionWatcher, joinAllPublicChannels } from "./watchers/slack-mentions";
import { setupGmailPoller } from "./watchers/gmail-poller";
import { setupGChatPoller, sendGChatReply } from "./watchers/gchat-poller";
import { setupReplyBridge } from "./watchers/reply-bridge";
import { setupDiscordReplyBridge } from "./watchers/discord-reply-bridge";
import { setupDiscordListener } from "./watchers/discord-listener";
import { sendDiscordReply } from "./discord-client";
import { buildSystemPrompt } from "./system-prompt";
import { detectSkill, buildSkillPrompt } from "./skill-router";
import { TaskQueue } from "./concurrency";
import { formatForSlack, toSlackMrkdwn } from "./slack-formatter";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// AI Employee system prompt (cached at startup)
const systemPrompt = buildSystemPrompt();

// Concurrency control
const taskQueue = new TaskQueue(config.MAX_CONCURRENT);

const app = new App({
  token: config.SLACK_BOT_TOKEN,
  appToken: config.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

// User Token client: posts messages as Yuto Suzuki (not as bot)
const userClient = new WebClient(config.SLACK_USER_TOKEN);

// ---- session management ----

/**
 * Map: Slack thread_ts → Claude session_id
 * Enables conversation continuity within a Slack thread.
 * Entries expire after SESSION_TTL_MS to prevent memory leaks.
 */
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const threadSessions = new Map<string, { sessionId: string; expiresAt: number }>();

function getSessionId(threadTs: string): string | undefined {
  const entry = threadSessions.get(threadTs);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    threadSessions.delete(threadTs);
    return undefined;
  }
  return entry.sessionId;
}

function setSessionId(threadTs: string, sessionId: string): void {
  threadSessions.set(threadTs, {
    sessionId,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
}

// Periodic cleanup of expired sessions (every 10 min)
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of threadSessions) {
    if (now > val.expiresAt) threadSessions.delete(key);
  }
}, 10 * 60 * 1000);

// ---- helpers ----

/**
 * Clean Slack message formatting:
 * - <https://example.com/> → https://example.com/
 * - <https://example.com/|example.com> → https://example.com/
 * - <@U12345> → (removed)
 * - <#C12345|channel-name> → #channel-name
 */
function cleanSlackMessage(text: string): string {
  return (
    text
      // Remove user mentions
      .replace(/<@[A-Z0-9]+>/g, "")
      // URLs: <https://...|label> → https://...
      .replace(/<(https?:\/\/[^|>]+)\|[^>]+>/g, "$1")
      // URLs: <https://...> → https://...
      .replace(/<(https?:\/\/[^>]+)>/g, "$1")
      // Channel refs: <#C123|name> → #name
      .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
      .trim()
  );
}

function splitMessage(text: string, maxLen = 3000): string[] {
  if (!text) return ["(empty response)"];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  return chunks;
}

async function handlePrompt(
  prompt: string,
  channel: string,
  threadTs: string,
  messageTs?: string
) {
  if (!prompt) {
    await app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "プロンプトを入力してください",
    });
    return;
  }

  console.log(`[bot] Received prompt (${prompt.length} chars): "${prompt.slice(0, 100)}..."`);

  // Add hourglass reaction to the original message
  if (messageTs) {
    await app.client.reactions.add({
      channel,
      timestamp: messageTs,
      name: "hourglass_flowing_sand",
    }).catch(() => {});
  }

  // Detect skill and determine budget
  const skillMatch = detectSkill(prompt);
  const budget = skillMatch?.budget ?? config.BUDGET_GENERAL;

  if (skillMatch) {
    console.log(`[bot] Skill detected: ${skillMatch.skillName} (budget: $${budget})`);
  }

  // Check concurrency — if queue is full, notify user
  if (taskQueue.runningCount >= config.MAX_CONCURRENT) {
    await app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `⏳ 他のタスク処理中です（待機: ${taskQueue.pendingCount + 1}件目）。順番に対応します。`,
    });
  }

  await taskQueue.acquire();

  // Skill/team runs spawn subagents and can take 10min+; use the longer ceiling
  const timeoutMs = skillMatch ? config.TIMEOUT_SKILL_MS : config.TIMEOUT_MS;
  const timeoutMin = Math.round(timeoutMs / 60000);

  // Post "accepted" status (async: result is posted to this thread when done)
  const skillLabel = skillMatch ? ` [${skillMatch.skillName}]` : "";
  const status = await app.client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: skillMatch
      ? `⏳ 受け付けました${skillLabel}。完了までかかる場合があります（上限${timeoutMin}分）。完了したらこのスレッドに投稿します。`
      : `⏳ 処理中...${skillLabel}`,
  });

  let settled = false; // once the run succeeds/fails, drop late progress updates

  try {
    // Look up existing session for this thread
    const resumeSessionId = getSessionId(threadTs);
    if (resumeSessionId) {
      console.log(`[bot] Resuming session ${resumeSessionId} for thread ${threadTs}`);
    }

    // Build the prompt: skill directive or raw user message
    const finalPrompt = skillMatch
      ? buildSkillPrompt(prompt, skillMatch.skillName)
      : prompt;

    // Streaming progress: update Slack message every few seconds
    let progressTs: string | undefined;
    let lastUpdateTime = 0;
    const PROGRESS_INTERVAL_MS = 3000; // Update every 3 seconds

    const { result, costUsd, sessionId } = await runClaude(finalPrompt, {
      resumeSessionId,
      maxBudgetUsd: budget,
      timeoutMs,
      // Subagent execution produces no stdout; silence is not a stuck signal here.
      // Let the global timeout be the only limit for Slack-routed prompts.
      idleTimeoutMs: timeoutMs,
      systemContext: resumeSessionId ? undefined : systemPrompt, // Only inject on new sessions
      onProgress: (text) => {
        if (settled) return;
        const now = Date.now();
        if (now - lastUpdateTime < PROGRESS_INTERVAL_MS) return;
        lastUpdateTime = now;

        // Convert markdown and truncate for Slack display
        const preview = toSlackMrkdwn(
          text.length > 3000 ? text.slice(0, 3000) + "\n…" : text
        );

        if (!progressTs) {
          // Post first progress message
          app.client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: preview,
          }).then((res) => {
            progressTs = res.ts!;
          }).catch(() => {});
        } else {
          // Update existing progress message
          app.client.chat.update({
            channel,
            ts: progressTs,
            text: preview,
          }).catch(() => {});
        }
      },
    });

    settled = true;

    // Store session ID for future messages in this thread
    if (sessionId) {
      setSessionId(threadTs, sessionId);
      console.log(`[bot] Stored session ${sessionId} for thread ${threadTs}`);
    }

    // Post final result. Long results are posted as summary + full-text
    // snippet (files.uploadV2) — posting the full text inline hits Slack
    // limits (msg_too_long / 50-block cap).
    const postFinal = async (payload: { text: string; blocks?: any[] }) => {
      if (progressTs) {
        await app.client.chat.update({ channel, ts: progressTs, ...payload });
      } else {
        await app.client.chat.postMessage({ channel, thread_ts: threadTs, ...payload });
      }
    };

    try {
      const formatted = formatForSlack(result);

      if (result.length > config.LONG_RESULT_THRESHOLD || formatted.blocks.length > 50) {
        console.log(`[bot] Long result (${result.length} chars) → posting as snippet`);

        // Summary: max 300 chars, cut at a line boundary when possible
        const head = result.slice(0, 300);
        const summary = head.slice(0, head.lastIndexOf("\n") > 150 ? head.lastIndexOf("\n") : 300);
        const summaryFormatted = formatForSlack(summary);
        const blocks = [
          ...summaryFormatted.blocks.slice(0, 45),
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `📄 上記は冒頭のみ。全文（${result.length.toLocaleString()}文字）はこのスレッドの snippet に添付`,
              },
            ],
          },
        ];
        await postFinal({ text: summaryFormatted.text, blocks });

        // Full text as a snippet (files.uploadV2) — readable inline incl. mobile
        const d = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
        await app.client.files.uploadV2({
          channel_id: channel,
          thread_ts: threadTs,
          filename: `claude-reply-${stamp}.md`,
          title: prompt.slice(0, 80),
          content: result,
          initial_comment: "全文はこちら（snippet）",
        });
      } else {
        await postFinal({ text: formatted.text, blocks: formatted.blocks as any });
      }
    } catch (postErr) {
      // Last-resort fallback: plain-text chunks always fit Slack limits
      const msg = postErr instanceof Error ? postErr.message : String(postErr);
      console.error(`[bot] Final post failed (${msg}) — falling back to text chunks`);
      if (progressTs) {
        await app.client.chat.delete({ channel, ts: progressTs }).catch(() => {});
      }
      for (const chunk of splitMessage(toSlackMrkdwn(result))) {
        await app.client.chat.postMessage({ channel, thread_ts: threadTs, text: chunk });
      }
    }

    // Update status
    const resumeLabel = resumeSessionId ? " 🔄" : "";
    await app.client.chat.update({
      channel,
      ts: status.ts!,
      text: `✅ 完了 ($${costUsd.toFixed(3)})${skillLabel}${resumeLabel}`,
    });

    // Replace hourglass with checkmark
    if (messageTs) {
      await app.client.reactions.remove({ channel, timestamp: messageTs, name: "hourglass_flowing_sand" }).catch(() => {});
      await app.client.reactions.add({ channel, timestamp: messageTs, name: "white_check_mark" }).catch(() => {});
    }
  } catch (err) {
    settled = true;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[bot] Error: ${msg}`);
    // 認証エラーの生文はメンバーの見える面へ出さない。中立文を出してオーナーへ 🔴 で回す
    if (isClaudeAuthError(err)) {
      await app.client.chat.update({
        channel,
        ts: status.ts!,
        text: `⚠️ 一時的に応答できませんでした。<@${config.MY_USER_ID}> さんへ通知しています。`,
      });
      await notifyOwnerAuthFailure(msg, channel);
    } else {
      await app.client.chat.update({
        channel,
        ts: status.ts!,
        text: `❌ エラー: ${msg.slice(0, 500)}`,
      });
    }

    // Replace hourglass with X
    if (messageTs) {
      await app.client.reactions.remove({ channel, timestamp: messageTs, name: "hourglass_flowing_sand" }).catch(() => {});
      await app.client.reactions.add({ channel, timestamp: messageTs, name: "x" }).catch(() => {});
    }
  } finally {
    taskQueue.release();
  }
}

// 認証失敗（1ターンも走らずに落ちた）をオーナーへ 🔴 で1日1回だけ知らせる。
// 復旧手順まで書く（credential-expiry-rules.md「再発行/再ログインを必ず本文に含める」）
let lastAuthAlertDay = "";
async function notifyOwnerAuthFailure(detail: string, srcChannel: string): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  if (lastAuthAlertDay === day) return; // 同一エラーの通知は1日1回に集約
  lastAuthAlertDay = day;
  const host = os.hostname();
  const body =
    "[claude-slack-bot] 結論: Bot の Claude 起動が認証で落ちました（1ターンも走らず課金ゼロ）。\n" +
    `理由: ${detail.slice(0, 200)}\n` +
    `論点: 稼働ホスト ${host} の長期トークン（~/.claude/.oauth-token）が失効・破損している可能性があります。` +
    "`claude setup-token` → `bash .claude/scripts/claude-token-install.sh` で入れ直してください。";
  await app.client.chat
    .postMessage({
      channel: config.DM_CHANNEL_ID,
      text: "[claude-slack-bot] 🔴 Bot の認証エラー｜メンションに応答できていません",
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: "🔴 Bot の認証エラー｜メンションに応答不可", emoji: true },
        },
        { type: "section", text: { type: "mrkdwn", text: body } },
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: `発生元: <#${srcChannel}>｜稼働ホスト: ${host}｜メンバーには中立文だけを返しています` },
          ],
        },
      ],
    })
    .catch(() => {});
}

// ---- event handlers ----

// @mention in channels (existing: Claude assistant)
app.event("app_mention", async ({ event }) => {
  const prompt = cleanSlackMessage(event.text);
  // Use thread_ts if replying in a thread, otherwise use event.ts as new thread root
  const threadTs = (event as any).thread_ts ?? event.ts;
  await handlePrompt(prompt, event.channel, threadTs, event.ts);
});

// DM (existing: Claude assistant)
app.event("message", async ({ event }) => {
  const e = event as any;
  if (e.channel_type !== "im" || e.subtype || e.bot_id) return;
  const prompt = cleanSlackMessage(e.text ?? "");
  // Use thread_ts if replying in a thread, otherwise use event.ts as new thread root
  const threadTs = e.thread_ts ?? e.ts;
  await handlePrompt(prompt, e.channel, threadTs, e.ts);
});

// ---- approval action handlers ----

// Helper: send the chosen reply text
async function sendApprovedReply(
  pending: ReturnType<typeof getPending>,
  replyText: string,
  client: any,
  msgTs?: string,
  patternLabel?: string
): Promise<void> {
  if (!pending) return;

  // Track whether the reply was actually delivered. `sent` flips to true only
  // AFTER the underlying send succeeds (before the ✅ confirmation DM), so a
  // failed send keeps the pending entry intact for retry instead of silently
  // clearing it and showing a misleading "送信済み".
  let sent = false;

  try {
    if (pending.sourceType === "slack" && pending.channel && pending.threadTs) {
      // Send reply as user (Yuto Suzuki) via User Token
      await userClient.chat.postMessage({
        channel: pending.channel,
        thread_ts: pending.threadTs,
        text: replyText,
      });
      sent = true;
      await client.chat.postMessage({
        channel: config.DM_CHANNEL_ID,
        text: `✅ Slack返信を送信しました${patternLabel ? `（${patternLabel}）` : ""}（${pending.contextLabel}）`,
      });
    } else if (pending.sourceType === "gmail" && pending.gmailMessageId) {
      const subject = pending.contextLabel.startsWith("Re:") ? pending.contextLabel : `Re: ${pending.contextLabel}`;
      await sendGmailReply(pending.gmailMessageId, replyText, subject);
      sent = true;
      await client.chat.postMessage({
        channel: config.DM_CHANNEL_ID,
        text: `✅ メール返信を送信しました${patternLabel ? `（${patternLabel}）` : ""}（${pending.contextLabel}）`,
      });
    } else if (pending.sourceType === "gchat" && pending.gchatSpaceName) {
      await sendGChatReply(pending.gchatSpaceName, replyText);
      sent = true;
      await client.chat.postMessage({
        channel: config.DM_CHANNEL_ID,
        text: `✅ Google Chat返信を送信しました${patternLabel ? `（${patternLabel}）` : ""}（${pending.contextLabel}）`,
      });
    } else if (pending.sourceType === "discord" && pending.discordChannelId && pending.discordMessageId) {
      // Sent by the BOT account (Discord disallows impersonating the human user)
      await sendDiscordReply(pending.discordChannelId, pending.discordMessageId, replyText);
      sent = true;
      await client.chat.postMessage({
        channel: config.DM_CHANNEL_ID,
        text: `✅ Discord返信を送信しました${patternLabel ? `（${patternLabel}）` : ""}（${pending.contextLabel}）`,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await client.chat.postMessage({
      channel: config.DM_CHANNEL_ID,
      text: `❌ 送信エラー: ${msg.slice(0, 300)}`,
    });
  }

  // If nothing was actually sent (send failed, or no matching branch), keep the
  // pending entry so the user can retry from the same buttons; the error was
  // already reported above. The entry still expires via APPROVAL_TTL_MS.
  if (!sent) return;

  removePending(pending.id);

  // Update the original message to show it's been handled
  try {
    if (msgTs) {
      await client.chat.update({
        channel: config.DM_CHANNEL_ID,
        ts: msgTs,
        text: `✅ 送信済み${patternLabel ? ` (${patternLabel})` : ""} | ${{ slack: "Slack", gmail: "Gmail", gchat: "Google Chat", discord: "Discord" }[pending.sourceType]} | ${pending.senderName}`,
        blocks: [],
      });
    }
  } catch { /* best effort */ }
}

// Pattern 1/2/3/4: approve and send the chosen reply
for (const idx of [1, 2, 3, 4] as const) {
  app.action(`approve_reply_${idx}`, async ({ action, ack, body, client }) => {
    await ack();
    const approvalId = (action as any).value;
    const pending = getPending(approvalId);

    if (!pending) {
      await client.chat.postMessage({
        channel: config.DM_CHANNEL_ID,
        text: "⚠️ この承認リクエストは期限切れです。",
      });
      return;
    }

    const replyText = pending.replyTexts[idx - 1] ?? pending.replyTexts[0];
    const msgTs = (body as any).message?.ts;
    await sendApprovedReply(pending, replyText, client, msgTs, `パターン${idx}`);
  });
}

// No: reject and discard
app.action("reject_reply", async ({ action, ack, body, client }) => {
  await ack();
  const approvalId = (action as any).value;
  const pending = getPending(approvalId);
  removePending(approvalId);

  // Update the original message
  try {
    const msgTs = (body as any).message?.ts;
    if (msgTs) {
      await client.chat.update({
        channel: config.DM_CHANNEL_ID,
        ts: msgTs,
        text: `❌ 却下済み | ${pending?.senderName ?? "unknown"}`,
        blocks: [],
      });
    }
  } catch { /* best effort */ }
});

// Comment: open modal for editing (pre-fill with pattern 1)
app.action("edit_reply", async ({ action, ack, body, client }) => {
  await ack();
  const approvalId = (action as any).value;
  const pending = getPending(approvalId);

  if (!pending) {
    await client.chat.postMessage({
      channel: config.DM_CHANNEL_ID,
      text: "⚠️ この承認リクエストは期限切れです。",
    });
    return;
  }

  await client.views.open({
    trigger_id: (body as any).trigger_id,
    view: buildEditModal(approvalId, pending.replyTexts[0]) as any,
  });
});

// Modal submission: send edited reply
app.view("edit_reply_modal", async ({ ack, view, client }) => {
  await ack();
  const approvalId = view.private_metadata;
  const pending = getPending(approvalId);

  if (!pending) {
    await client.chat.postMessage({
      channel: config.DM_CHANNEL_ID,
      text: "⚠️ この承認リクエストは期限切れです。",
    });
    return;
  }

  const editedText = view.state.values.reply_block.reply_text.value ?? pending.replyTexts[0];
  const msgTs = undefined; // modal doesn't have original message ts
  await sendApprovedReply(pending, editedText, client, msgTs, "編集済み");
});

// ---- board-team approval handlers ----

// OK（全承認）: trigger Claude to execute approved actions
app.action("board_ok", async ({ action, ack, body, client }) => {
  await ack();
  const msgTs = (body as any).message?.ts;
  const channel = (body as any).channel?.id ?? config.DM_CHANNEL_ID;

  // Update original message to show approved state
  try {
    if (msgTs) {
      // Get original blocks and replace the actions block with a confirmation
      const originalBlocks = (body as any).message?.blocks ?? [];
      const updatedBlocks = originalBlocks
        .filter((b: any) => b.type !== "actions")
        .concat({
          type: "section",
          text: { type: "mrkdwn", text: "✅ *全承認済み* — アクション実行中..." },
        });
      await client.chat.update({
        channel,
        ts: msgTs,
        text: "✅ ボードチーム全承認済み",
        blocks: updatedBlocks,
      });
    }
  } catch { /* best effort */ }

  // Trigger Claude to execute Phase 9
  const threadTs = msgTs ?? (body as any).message?.thread_ts;
  await handlePrompt(
    "ボードチームをdaily-autoモードで起動して Phase 9 を実行してください。承認内容: OK（全アクション承認）",
    channel,
    threadTs,
  );
});

// NG（却下）: open modal for rejection details
app.action("board_ng", async ({ action, ack, body, client }) => {
  await ack();
  const msgTs = (body as any).message?.ts ?? "unknown";

  await client.views.open({
    trigger_id: (body as any).trigger_id,
    view: {
      type: "modal" as const,
      callback_id: "board_ng_modal",
      private_metadata: JSON.stringify({ msgTs, channel: (body as any).channel?.id }),
      title: { type: "plain_text" as const, text: "アクション却下" },
      submit: { type: "plain_text" as const, text: "却下を送信" },
      close: { type: "plain_text" as const, text: "キャンセル" },
      blocks: [
        {
          type: "input",
          block_id: "board_ng_block",
          label: { type: "plain_text" as const, text: "却下内容（例: NG 2 理由）" },
          element: {
            type: "plain_text_input",
            action_id: "board_ng_text",
            multiline: true,
            placeholder: { type: "plain_text" as const, text: "NG 2 優先度低のため保留" },
          },
        },
      ],
    } as any,
  });
});

// NG modal submission
app.view("board_ng_modal", async ({ ack, view, client }) => {
  await ack();
  const { msgTs, channel } = JSON.parse(view.private_metadata);
  const ngText = view.state.values.board_ng_block.board_ng_text.value ?? "NG";

  // Update original message
  try {
    if (msgTs && msgTs !== "unknown") {
      await client.chat.update({
        channel: channel ?? config.DM_CHANNEL_ID,
        ts: msgTs,
        text: `❌ 却下: ${ngText}`,
        blocks: [],
      });
    }
  } catch { /* best effort */ }

  // Trigger Claude to handle the NG
  await handlePrompt(
    `ボードチームをdaily-autoモードで起動して Phase 9 を実行してください。承認内容: ${ngText}`,
    channel ?? config.DM_CHANNEL_ID,
    msgTs,
  );
});

// コメント: open modal for free-form comment
app.action("board_comment", async ({ action, ack, body, client }) => {
  await ack();
  const msgTs = (body as any).message?.ts ?? "unknown";

  await client.views.open({
    trigger_id: (body as any).trigger_id,
    view: {
      type: "modal" as const,
      callback_id: "board_comment_modal",
      private_metadata: JSON.stringify({ msgTs, channel: (body as any).channel?.id }),
      title: { type: "plain_text" as const, text: "コメント" },
      submit: { type: "plain_text" as const, text: "コメントを送信" },
      close: { type: "plain_text" as const, text: "キャンセル" },
      blocks: [
        {
          type: "input",
          block_id: "board_comment_block",
          label: { type: "plain_text" as const, text: "コメント内容" },
          element: {
            type: "plain_text_input",
            action_id: "board_comment_text",
            multiline: true,
            placeholder: { type: "plain_text" as const, text: "OK 1,3 のみ承認。2は保留" },
          },
        },
      ],
    } as any,
  });
});

// Comment modal submission
app.view("board_comment_modal", async ({ ack, view, client }) => {
  await ack();
  const { msgTs, channel } = JSON.parse(view.private_metadata);
  const commentText = view.state.values.board_comment_block.board_comment_text.value ?? "";

  // Update original message
  try {
    if (msgTs && msgTs !== "unknown") {
      await client.chat.update({
        channel: channel ?? config.DM_CHANNEL_ID,
        ts: msgTs,
        text: `💬 コメント: ${commentText}`,
        blocks: [],
      });
    }
  } catch { /* best effort */ }

  // Trigger Claude to handle the comment
  await handlePrompt(
    `ボードチームをdaily-autoモードで起動して Phase 9 を実行してください。承認内容: ${commentText}`,
    channel ?? config.DM_CHANNEL_ID,
    msgTs,
  );
});

// ---- Generic skill action handlers ----

// OK / 確認済み: execute approved action or acknowledge
app.action("skill_ok", async ({ action, ack, body, client }) => {
  await ack();
  const msgTs = (body as any).message?.ts;
  const channel = (body as any).channel?.id ?? config.DM_CHANNEL_ID;

  let skillName = "unknown";
  let prompt = "確認済み";
  try {
    const parsed = JSON.parse((action as any).value ?? "{}");
    skillName = parsed.skill ?? "unknown";
    prompt = parsed.prompt ?? "確認済み";
  } catch { /* use defaults */ }

  // Update original message to show approved state
  try {
    if (msgTs) {
      const originalBlocks = (body as any).message?.blocks ?? [];
      const updatedBlocks = originalBlocks
        .filter((b: any) => b.type !== "actions")
        .concat({
          type: "section",
          text: { type: "mrkdwn", text: `✅ *承認済み*（${skillName}）` },
        });
      await client.chat.update({
        channel,
        ts: msgTs,
        text: `✅ ${skillName} 承認済み`,
        blocks: updatedBlocks,
      });
    }
  } catch { /* best effort */ }

  // If prompt is just "確認済み", skip Claude invocation (no follow-up needed)
  if (prompt === "確認済み") return;

  // Trigger Claude to execute the skill's follow-up action
  const threadTs = msgTs ?? (body as any).message?.thread_ts;
  await handlePrompt(prompt, channel, threadTs);
});

// NG: open modal for rejection details
app.action("skill_ng", async ({ action, ack, body, client }) => {
  await ack();
  const msgTs = (body as any).message?.ts ?? "unknown";

  let skillName = "unknown";
  try {
    const parsed = JSON.parse((action as any).value ?? "{}");
    skillName = parsed.skill ?? "unknown";
  } catch { /* use defaults */ }

  await client.views.open({
    trigger_id: (body as any).trigger_id,
    view: {
      type: "modal" as const,
      callback_id: "skill_ng_modal",
      private_metadata: JSON.stringify({ msgTs, channel: (body as any).channel?.id, skill: skillName }),
      title: { type: "plain_text" as const, text: "却下" },
      submit: { type: "plain_text" as const, text: "却下を送信" },
      close: { type: "plain_text" as const, text: "キャンセル" },
      blocks: [
        {
          type: "input",
          block_id: "skill_ng_block",
          label: { type: "plain_text" as const, text: "却下理由" },
          element: {
            type: "plain_text_input",
            action_id: "skill_ng_text",
            multiline: true,
            placeholder: { type: "plain_text" as const, text: "却下理由を入力してください" },
          },
        },
      ],
    } as any,
  });
});

// NG modal submission
app.view("skill_ng_modal", async ({ ack, view, client }) => {
  await ack();
  const { msgTs, channel, skill } = JSON.parse(view.private_metadata);
  const ngText = view.state.values.skill_ng_block.skill_ng_text.value ?? "NG";

  // Update original message
  try {
    if (msgTs && msgTs !== "unknown") {
      await client.chat.update({
        channel: channel ?? config.DM_CHANNEL_ID,
        ts: msgTs,
        text: `❌ 却下（${skill}）: ${ngText}`,
        blocks: [],
      });
    }
  } catch { /* best effort */ }

  await handlePrompt(
    `/${skill} スキルに従って実行してください。ユーザーの指示: NG — ${ngText}`,
    channel ?? config.DM_CHANNEL_ID,
    msgTs,
  );
});

// コメント: open modal for free-form comment
app.action("skill_comment", async ({ action, ack, body, client }) => {
  await ack();
  const msgTs = (body as any).message?.ts ?? "unknown";

  let skillName = "unknown";
  try {
    const parsed = JSON.parse((action as any).value ?? "{}");
    skillName = parsed.skill ?? "unknown";
  } catch { /* use defaults */ }

  await client.views.open({
    trigger_id: (body as any).trigger_id,
    view: {
      type: "modal" as const,
      callback_id: "skill_comment_modal",
      private_metadata: JSON.stringify({ msgTs, channel: (body as any).channel?.id, skill: skillName }),
      title: { type: "plain_text" as const, text: "コメント" },
      submit: { type: "plain_text" as const, text: "コメントを送信" },
      close: { type: "plain_text" as const, text: "キャンセル" },
      blocks: [
        {
          type: "input",
          block_id: "skill_comment_block",
          label: { type: "plain_text" as const, text: "コメント内容" },
          element: {
            type: "plain_text_input",
            action_id: "skill_comment_text",
            multiline: true,
            placeholder: { type: "plain_text" as const, text: "コメントを入力してください" },
          },
        },
      ],
    } as any,
  });
});

// Comment modal submission
app.view("skill_comment_modal", async ({ ack, view, client }) => {
  await ack();
  const { msgTs, channel, skill } = JSON.parse(view.private_metadata);
  const commentText = view.state.values.skill_comment_block.skill_comment_text.value ?? "";

  // Update original message
  try {
    if (msgTs && msgTs !== "unknown") {
      const originalMsg = await client.conversations.history({
        channel: channel ?? config.DM_CHANNEL_ID,
        latest: msgTs,
        inclusive: true,
        limit: 1,
      });
      const originalBlocks = (originalMsg.messages?.[0] as any)?.blocks ?? [];
      const updatedBlocks = originalBlocks
        .filter((b: any) => b.type !== "actions")
        .concat({
          type: "section",
          text: { type: "mrkdwn", text: `💬 *コメント*: ${commentText}` },
        });
      await client.chat.update({
        channel: channel ?? config.DM_CHANNEL_ID,
        ts: msgTs,
        text: `💬 コメント（${skill}）: ${commentText}`,
        blocks: updatedBlocks,
      });
    }
  } catch { /* best effort */ }

  await handlePrompt(
    `/${skill} スキルに従って実行してください。ユーザーのコメント: ${commentText}`,
    channel ?? config.DM_CHANNEL_ID,
    msgTs,
  );
});

// ---- Generic "open HTML in browser" handler ----
// Any skill can attach a button {action_id: "open_html", value: "<abs path>"} to
// open a local HTML artifact in this Mac's default browser. Security: only
// existing .html/.htm files under ~/Downloads are allowed (per the
// .claude/rules/html-output-rules.md all review HTML lives there), and the
// resolved realpath is checked so symlinks can't escape the allowlist.
app.action("open_html", async ({ action, ack, respond }) => {
  await ack();
  const rawValue = String((action as any).value ?? "").trim();
  const expanded = rawValue.startsWith("~/")
    ? path.join(os.homedir(), rawValue.slice(2))
    : rawValue;

  let message: string;
  try {
    const real = await fs.promises.realpath(expanded);
    const allowedRoot = await fs.promises.realpath(path.join(os.homedir(), "Downloads"));
    const inAllowed = real.startsWith(allowedRoot + path.sep);
    const isHtml = /\.html?$/i.test(real);
    const isFile = inAllowed && isHtml && (await fs.promises.stat(real)).isFile();
    if (!isFile) {
      message = `⚠️ このパスは開けません（~/Downloads 配下の .html ファイルのみ許可）: \`${rawValue}\``;
    } else {
      await execFileAsync("/usr/bin/open", [real], { timeout: 10000 });
      message = `✅ ブラウザで開きました: \`${path.basename(real)}\``;
    }
  } catch (e: any) {
    message = e?.code === "ENOENT"
      ? `⚠️ ファイルが見つかりません（削除済みの可能性）: \`${rawValue}\``
      : `⚠️ 開けませんでした: ${e?.message ?? String(e)}`;
  }

  // 成功時は通知しない（ブラウザが開くこと自体がフィードバック）。失敗時のみ ephemeral で通知する。
  if (message.startsWith("⚠️")) {
    console.error(`[open_html] failed: ${message} (value=${rawValue})`);
    try {
      await respond({ response_type: "ephemeral", replace_original: false, text: message });
    } catch (e: any) {
      console.error(`[open_html] respond failed: ${e?.message ?? e}`);
    }
  }
});

// ---- Gmail reply helper ----

async function sendGmailReply(messageId: string, body: string, subject: string): Promise<void> {
  const escapedBody = body.replace(/'/g, "'\\''");
  const escapedSubject = subject.replace(/'/g, "'\\''");
  await execAsync(
    `/opt/homebrew/bin/gog gmail send --reply-to-message-id ${messageId} --reply-all --subject '${escapedSubject}' --body '${escapedBody}' --account ${config.GMAIL_ACCOUNT} --no-input --force`,
    { timeout: 30000 }
  );
}

// ---- start ----

(async () => {
  await app.start();
  console.log("⚡ Claude Slack Bot is running (Socket Mode)");

  // Join all public channels, then register auto-reply watchers
  await joinAllPublicChannels(app);
  // [DISABLED 2026-04-28] 自動返信ワークフロー停止（裕斗指示）
  // Slackメンション・Gmail・GChatの自動返信案生成を停止。
  // Bot のDM/メンション対話アシスタント機能と承認ボタンは維持。
  // setupSlackMentionWatcher(app);
  // setupGmailPoller(app);
  // setupGChatPoller(app);

  // [2026-06-06] File-bridge: launchd `slack-reply` skill -> buttoned approval DM.
  // Detection/generation stays in the external skill; this bot owns the pending
  // store + approve_reply_* handlers, so the buttons resolve here. (auto-join /
  // mention watcher remain DISABLED above.)
  setupReplyBridge(app);

  // [2026-06-18] Discord: Gateway listener detects server-wide @mentions and
  // enqueues them; the launchd `discord-reply` skill generates reply drafts and
  // writes bridge requests; this consumer posts the buttoned approval DM (Slack).
  // The bridge consumer is always on (cheap file poll). The Gateway listener only
  // starts when explicitly enabled and a token is present.
  setupDiscordReplyBridge(app);
  if (config.DISCORD_ENABLED && config.DISCORD_BOT_TOKEN) {
    setupDiscordListener(app).catch((e) =>
      console.error(`[discord-listener] failed to start: ${e}`)
    );
  } else {
    console.log("[discord-listener] disabled (set DISCORD_ENABLED=true + DISCORD_BOT_TOKEN to enable)");
  }

  console.log("📬 Auto-reply system activated");
})();
