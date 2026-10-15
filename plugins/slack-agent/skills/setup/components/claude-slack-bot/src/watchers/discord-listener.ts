import type { App } from "@slack/bolt";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { config } from "../config";
import { getDiscordClient, ensureDiscordLogin } from "../discord-client";

/**
 * Discord Gateway listener (detection only).
 *
 * On every `messageCreate`, it filters for server-wide @mentions of the target
 * user (DISCORD_TARGET_USER_ID), fetches recent channel context, and enqueues a
 * candidate JSON to `~/.claude/state/discord-reply/queue/<messageId>.json`.
 *
 * Generation is intentionally NOT done here: the launchd `discord-reply` skill
 * (a separate Claude CLI process) drains the queue, generates reply drafts with
 * full Vault knowledge, and writes a bridge request that the
 * `discord-reply-bridge` watcher turns into a Slack approval card. This keeps the
 * resident bot lightweight (discord.js only) and mirrors the proven Slack flow
 * (detect → enqueue → generate → bridge → approve).
 *
 * Dedup: an in-session Set guards against duplicate Gateway deliveries; an
 * on-disk existence check guards against re-enqueuing a not-yet-drained message.
 * Discord Gateway never replays history on reconnect, so there is no backlog to
 * suppress (unlike Slack search) — messages sent while the bot is down are
 * simply not seen.
 */

const QUEUE_DIR = path.join(os.homedir(), ".claude/state/discord-reply/queue");
const SEEN_CAP = 2000;
const seen = new Set<string>();

function ensureDir(): void {
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
}

function remember(messageId: string): void {
  seen.add(messageId);
  if (seen.size > SEEN_CAP) {
    const oldest = seen.values().next().value;
    if (oldest) seen.delete(oldest);
  }
}

function alreadyQueued(messageId: string): boolean {
  if (seen.has(messageId)) return true;
  try {
    fs.accessSync(path.join(QUEUE_DIR, `${messageId}.json`));
    return true;
  } catch {
    return false;
  }
}

function atomicWrite(file: string, data: unknown): void {
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export async function setupDiscordListener(_app: App): Promise<void> {
  if (!config.DISCORD_TARGET_USER_ID) {
    console.warn("[discord-listener] DISCORD_TARGET_USER_ID not set — listener will not enqueue anything");
  }
  ensureDir();
  const client = getDiscordClient();

  client.once("ready", (c) => {
    console.log(`[discord-listener] up as ${c.user.tag} (watching @mentions of ${config.DISCORD_TARGET_USER_ID || "<unset>"})`);
  });

  client.on("messageCreate", async (message) => {
    try {
      if (message.author?.bot) return;
      if (!message.guild) return; // scope = server-wide @mention (ignore DMs)
      if (
        config.DISCORD_GUILD_IDS.length > 0 &&
        !config.DISCORD_GUILD_IDS.includes(message.guild.id)
      ) {
        return;
      }
      if (!config.DISCORD_TARGET_USER_ID) return;
      if (message.author?.id === config.DISCORD_TARGET_USER_ID) return; // don't draft replies to self
      if (!message.mentions?.users?.has(config.DISCORD_TARGET_USER_ID)) return;
      if (alreadyQueued(message.id)) return;
      remember(message.id);

      // Recent channel context (best effort; oldest → newest)
      let context: Array<{ author: string; content: string }> = [];
      try {
        const recent = await message.channel.messages.fetch({
          limit: config.DISCORD_CONTEXT_MESSAGES,
          before: message.id,
        });
        context = [...recent.values()]
          .reverse()
          .map((m) => ({ author: m.author?.username ?? "unknown", content: m.content ?? "" }));
      } catch (err) {
        console.warn(`[discord-listener] context fetch failed (${message.id}): ${err}`);
      }

      const channelName = (message.channel as any)?.name ?? message.channelId;
      const candidate = {
        messageId: message.id,
        channelId: message.channelId,
        guildId: message.guild.id,
        channelName,
        guildName: message.guild.name ?? message.guild.id,
        authorName: message.author?.username ?? "unknown",
        authorId: message.author?.id ?? "",
        content: message.content ?? "",
        permalink: `https://discord.com/channels/${message.guild.id}/${message.channelId}/${message.id}`,
        context,
        createdAt: Date.now(),
      };

      try {
        atomicWrite(path.join(QUEUE_DIR, `${message.id}.json`), candidate);
      } catch (writeErr) {
        // Roll back the in-session dedup marker so a later duplicate Gateway
        // delivery can retry the enqueue (Gateway never replays history, so a
        // dropped marker would otherwise mean a permanently lost mention).
        seen.delete(message.id);
        throw writeErr;
      }
      console.log(
        `[discord-listener] queued mention ${message.id} from ${candidate.authorName} in #${channelName}`
      );
    } catch (err) {
      console.error(`[discord-listener] error handling message: ${err}`);
    }
  });

  await ensureDiscordLogin();
}
