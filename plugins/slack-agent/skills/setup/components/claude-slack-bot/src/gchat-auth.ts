import { google } from "googleapis";
import { config } from "./config";

let cachedClient: InstanceType<typeof google.auth.OAuth2> | null = null;

/**
 * Get an authenticated OAuth2 client for Google Chat API.
 * Uses refresh token from config; auto-refreshes access tokens.
 *
 * Prerequisites:
 * 1. Google Cloud project with Chat API enabled
 * 2. OAuth Desktop client credentials (Client ID + Secret)
 * 3. Refresh token obtained via initial browser auth flow
 *
 * To obtain a refresh token for the first time, run:
 *   npx tsx src/gchat-auth.ts
 */
export function getGChatAuthClient(): InstanceType<typeof google.auth.OAuth2> {
  if (cachedClient) return cachedClient;

  if (!config.GCHAT_CLIENT_ID || !config.GCHAT_CLIENT_SECRET || !config.GCHAT_REFRESH_TOKEN) {
    throw new Error(
      "[gchat-auth] Missing GCHAT_CLIENT_ID, GCHAT_CLIENT_SECRET, or GCHAT_REFRESH_TOKEN in .env"
    );
  }

  const oauth2Client = new google.auth.OAuth2(
    config.GCHAT_CLIENT_ID,
    config.GCHAT_CLIENT_SECRET,
    "urn:ietf:wg:oauth:2.0:oob" // Desktop app redirect
  );

  oauth2Client.setCredentials({
    refresh_token: config.GCHAT_REFRESH_TOKEN,
  });

  cachedClient = oauth2Client;
  return oauth2Client;
}

// ---- CLI: Initial token acquisition ----
// Run this file directly to get a refresh token for the first time.

const SCOPES = [
  "https://www.googleapis.com/auth/chat.spaces.readonly",
  "https://www.googleapis.com/auth/chat.messages.readonly",
  "https://www.googleapis.com/auth/chat.messages.create",
  "https://www.googleapis.com/auth/chat.users.readstate.readonly",
];

async function acquireToken(): Promise<void> {
  if (!config.GCHAT_CLIENT_ID || !config.GCHAT_CLIENT_SECRET) {
    console.error("Set GCHAT_CLIENT_ID and GCHAT_CLIENT_SECRET in .env first.");
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(
    config.GCHAT_CLIENT_ID,
    config.GCHAT_CLIENT_SECRET,
    "http://localhost:3456/oauth2callback"
  );

  const authorizeUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  console.log("\n🔐 Google Chat API 認証フロー");
  console.log("以下のURLをブラウザで開いてください:\n");
  console.log(authorizeUrl);
  console.log("\n認証後、リダイレクトURLからcodeパラメータを取得してください。");
  console.log("Waiting for callback on http://localhost:3456/oauth2callback ...\n");

  // Start a temporary HTTP server to catch the OAuth callback
  const http = await import("http");
  const url = await import("url");

  const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url ?? "", true);
    const code = parsedUrl.query.code as string | undefined;

    if (!code) {
      res.writeHead(400);
      res.end("Missing code parameter");
      return;
    }

    try {
      const { tokens } = await oauth2Client.getToken(code);
      console.log("\n✅ トークン取得成功!");
      console.log(`\nGCHAT_REFRESH_TOKEN=${tokens.refresh_token}\n`);
      console.log("↑ この値を .env に追加してください。");

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>認証成功！このタブを閉じてください。</h1>");
    } catch (err) {
      console.error("Token exchange failed:", err);
      res.writeHead(500);
      res.end("Token exchange failed");
    } finally {
      server.close();
    }
  });

  server.listen(3456);
}

// If run directly (not imported)
if (require.main === module) {
  acquireToken().catch(console.error);
}
