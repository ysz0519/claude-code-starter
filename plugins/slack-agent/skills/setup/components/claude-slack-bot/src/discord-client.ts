import { Client, GatewayIntentBits, Partials } from "discord.js";
import { config } from "./config";

/**
 * Shared discord.js client for the bot.
 *
 * Used by:
 *  - `watchers/discord-listener.ts` (read): receives Gateway `messageCreate`
 *    events, detects server-wide @mentions of the target user, enqueues them.
 *  - `index.ts` `sendApprovedReply()` (write): when the user clicks a send
 *    button on a Discord approval card, posts the chosen reply back to the
 *    original Discord message as a reply.
 *
 * Login is idempotent: whichever path needs the client first triggers a single
 * `login()`; the other awaits the same promise. If the listener is disabled,
 * the send path logs in lazily on first use.
 */

let client: Client | null = null;
let loginPromise: Promise<unknown> | null = null;

export function getDiscordClient(): Client {
  if (!client) {
    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });
  }
  return client;
}

export async function ensureDiscordLogin(): Promise<Client> {
  const c = getDiscordClient();
  if (!config.DISCORD_BOT_TOKEN) {
    throw new Error("DISCORD_BOT_TOKEN is not set");
  }
  if (!loginPromise) {
    // Reset on failure so a later caller can retry (a stuck rejected promise
    // would otherwise poison every read/send path until process restart).
    loginPromise = c.login(config.DISCORD_BOT_TOKEN).catch((err) => {
      loginPromise = null;
      throw err;
    });
  }
  await loginPromise;
  return c;
}

/**
 * Send a reply to a Discord message. The reply is posted by the BOT account
 * (Discord does not allow impersonating the human user), referencing the
 * original message so it threads under it in the channel.
 */
export async function sendDiscordReply(
  channelId: string,
  messageId: string,
  text: string
): Promise<void> {
  const c = await ensureDiscordLogin();
  const channel = await c.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    throw new Error(`Discord channel ${channelId} is not a sendable text channel`);
  }
  await (channel as any).send({
    content: text,
    reply: { messageReference: messageId, failIfNotExists: false },
    allowedMentions: { repliedUser: true },
  });
}
