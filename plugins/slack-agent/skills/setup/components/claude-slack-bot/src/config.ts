import "dotenv/config";
import os from "node:os";
import path from "node:path";

// 配布版: 個人依存値はすべて .env から供給する（既定値に個人の ID・パスを持たない）。
// 必須値が欠けたまま起動すると Slack 上で誤爆するため、起動時に fail-fast させる。
const REQUIRED = [
  "SLACK_BOT_TOKEN",
  "SLACK_USER_TOKEN",
  "SLACK_APP_TOKEN",
  "DEFAULT_CWD",
  "MY_USER_ID",
  "DM_CHANNEL_ID",
] as const;

const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(
    `[config] .env に必須項目がありません: ${missing.join(", ")}\n` +
      `  setup.sh を実行し直すか、claude-slack-bot/.env を直接編集してください。`,
  );
  process.exit(78); // EX_CONFIG
}

const defaultCwd = process.env.DEFAULT_CWD!;

export const config = {
  SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN!,
  SLACK_USER_TOKEN: process.env.SLACK_USER_TOKEN!,
  SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN!,
  /** Slack 上で名乗る Bot 名（システムプロンプト・通知文言に使う） */
  BOT_NAME: process.env.BOT_NAME ?? "claude_bot",
  /** Bot の持ち主の呼び名（システムプロンプト・宛先判定に使う） */
  OWNER_NAME: process.env.OWNER_NAME ?? "オーナー",
  DEFAULT_CWD: defaultCwd,
  MODEL: process.env.MODEL ?? "sonnet",
  MAX_TURNS: Number(process.env.MAX_TURNS ?? "10"),
  TIMEOUT_MS: Number(process.env.TIMEOUT_MS ?? "600000"), // 10 min (absolute max, general prompts)
  // Skill/team runs spawn subagents and legitimately take 10min+ — give them a longer ceiling
  TIMEOUT_SKILL_MS: Number(process.env.TIMEOUT_SKILL_MS ?? "1800000"), // 30 min (absolute max, skill/team runs)
  // NOTE: stream-json emits nothing while a tool call (esp. subagent) is running,
  // so "no stdout" is NOT a reliable stuck signal. Keep this as a loose safety valve only.
  IDLE_TIMEOUT_MS: Number(process.env.IDLE_TIMEOUT_MS ?? "600000"), // 10 min (no output = likely stuck)
  // Results longer than this are saved as an HTML artifact (~/Downloads) and
  // posted to Slack as summary + open_html button instead of inline text
  LONG_RESULT_THRESHOLD: Number(process.env.LONG_RESULT_THRESHOLD ?? "3500"),

  // --- AI Employee: Skills & Budget ---
  SKILLS_DIR:
    process.env.SKILLS_DIR ?? path.join(defaultCwd, ".claude", "skills"),
  BUDGET_GENERAL: Number(process.env.BUDGET_GENERAL ?? "1.0"),
  BUDGET_SKILL: Number(process.env.BUDGET_SKILL ?? "3.0"),
  BUDGET_TEAM: Number(process.env.BUDGET_TEAM ?? "5.0"),
  MAX_CONCURRENT: Number(process.env.MAX_CONCURRENT ?? "2"),

  // --- Auto-reply system ---
  /** Slack user ID to monitor mentions for */
  MY_USER_ID: process.env.MY_USER_ID!,
  /** Slack DM channel to send approval requests to */
  DM_CHANNEL_ID: process.env.DM_CHANNEL_ID!,
  /** Gmail account for gogcli（Gmail 連携を使う場合のみ設定。既定は無効） */
  GMAIL_ACCOUNT: process.env.GMAIL_ACCOUNT ?? "",
  /** Gmail polling interval in ms (default: 1 hour) */
  GMAIL_POLL_INTERVAL_MS: Number(process.env.GMAIL_POLL_INTERVAL_MS ?? "3600000"),
  /** Approval request TTL in ms (default: 30 min) */
  APPROVAL_TTL_MS: Number(process.env.APPROVAL_TTL_MS ?? "1800000"),
  /** Max conversation context messages to fetch */
  CONTEXT_MESSAGES: Number(process.env.CONTEXT_MESSAGES ?? "5"),

  // --- Google Chat auto-reply ---
  /** Enable Google Chat DM poller */
  GCHAT_ENABLED: process.env.GCHAT_ENABLED === "true",
  /** OAuth2 Client ID for Google Chat API */
  GCHAT_CLIENT_ID: process.env.GCHAT_CLIENT_ID ?? "",
  /** OAuth2 Client Secret for Google Chat API */
  GCHAT_CLIENT_SECRET: process.env.GCHAT_CLIENT_SECRET ?? "",
  /** OAuth2 Refresh Token for Google Chat API */
  GCHAT_REFRESH_TOKEN: process.env.GCHAT_REFRESH_TOKEN ?? "",
  /** Google Chat polling interval in ms (default: 1 min) */
  GCHAT_POLL_INTERVAL_MS: Number(process.env.GCHAT_POLL_INTERVAL_MS ?? "60000"),

};
