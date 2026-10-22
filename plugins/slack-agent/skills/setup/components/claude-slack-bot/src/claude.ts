import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, readdirSync, readFileSync } from "fs";
import { config } from "./config";

function findClaudePath(): string {
  // 1. 固定パス（npm global install等）
  const fixedCandidates = [
    "/usr/local/bin/claude",
    `${process.env.HOME}/.claude/local/claude`,
    `${process.env.HOME}/.npm-global/bin/claude`,
  ];
  for (const p of fixedCandidates) {
    if (existsSync(p)) return p;
  }

  // 2. Claude Desktop自動更新ディレクトリ（バージョン動的検出）
  const codeDir = `${process.env.HOME}/Library/Application Support/Claude/claude-code`;
  try {
    const versions = readdirSync(codeDir)
      .filter((d) => /^\d+\.\d+\.\d+$/.test(d))
      .sort((a, b) => {
        const pa = a.split(".").map(Number);
        const pb = b.split(".").map(Number);
        for (let i = 0; i < 3; i++) {
          if (pa[i] !== pb[i]) return pb[i] - pa[i];
        }
        return 0;
      });
    for (const v of versions) {
      const p = `${codeDir}/${v}/claude`;
      if (existsSync(p)) return p;
    }
  } catch {
    // codeDir doesn't exist — skip
  }

  return "claude"; // fallback: rely on PATH
}

const CLAUDE_BIN = findClaudePath();
console.log(`[claude] Binary: ${CLAUDE_BIN}`);

// 長期トークン（~/.claude/.oauth-token・`claude setup-token` で発行・1年）があれば供給する。
// これが無いと対話用の
// Keychain OAuth のリフレッシュに依存し、失敗すると1ターンも走らずに落ちる。
const LAUNCHD_TOKEN_FILE = `${process.env.HOME}/.claude/.oauth-token`;
function readLaunchdToken(): string | undefined {
  try {
    const tok = readFileSync(LAUNCHD_TOKEN_FILE, "utf-8").trim();
    return tok.startsWith("sk-ant-") ? tok : undefined;
  } catch {
    return undefined; // 読めなければ従来どおり Keychain に委ねる（fail-open）
  }
}

/** 認証で落ちた（＝1ターンも走っていない）ことを呼び出し元へ型で伝える */
export class ClaudeAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeAuthError";
  }
}
export function isClaudeAuthError(err: unknown): boolean {
  return err instanceof Error && err.name === "ClaudeAuthError";
}
// CLI が result として返す認証失敗の文言（本文が短く・課金ゼロのときだけ適用する）
const AUTH_FAIL_RE =
  /OAuth session expired|Failed to authenticate|authentication_error|Invalid API key|Please run .?\/login/i;

export interface ClaudeResult {
  result: string;
  costUsd: number;
  sessionId?: string;
}

/**
 * Run Claude CLI with stream-json output.
 * Calls onProgress with incremental text as it arrives.
 */
export async function runClaude(
  prompt: string,
  options?: {
    maxTurns?: number;
    maxBudgetUsd?: number;
    systemContext?: string;
    cwd?: string;
    resumeSessionId?: string;
    onProgress?: (text: string) => void;
    /** Absolute max run time. Defaults to config.TIMEOUT_MS. */
    timeoutMs?: number;
    /** Max silence on stdout before treating the run as stuck. Defaults to config.IDLE_TIMEOUT_MS. */
    idleTimeoutMs?: number;
  }
): Promise<ClaudeResult> {
  const args = [
    "-p",
    "--verbose",
    "--output-format", "stream-json",
    "--dangerously-skip-permissions",
    "--model", config.MODEL,
    "--max-turns", String(options?.maxTurns ?? config.MAX_TURNS),
  ];

  // Budget control
  if (options?.maxBudgetUsd) {
    args.push("--max-budget-usd", String(options.maxBudgetUsd));
  }

  // Resume previous session if sessionId is provided; otherwise fix the new
  // session's ID upfront so it can be exported as CLAUDE_SESSION_ID (below)
  const sessionIdForRun = options?.resumeSessionId ?? randomUUID();
  if (options?.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  } else {
    args.push("--session-id", sessionIdForRun);
  }

  // Build final prompt: system context + user prompt
  const finalPrompt = options?.systemContext
    ? `${options.systemContext}\n---\n\n${prompt}`
    : prompt;

  // Prompt must be the last argument
  args.push(finalPrompt);

  const isResume = !!options?.resumeSessionId;
  console.log(`[claude] Prompt: "${prompt.slice(0, 120)}..."`);
  console.log(`[claude] model=${config.MODEL}, max-turns=${options?.maxTurns ?? config.MAX_TURNS}, resume=${isResume ? options.resumeSessionId : "none"}`);
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd: options?.cwd ?? config.DEFAULT_CWD,
      stdio: ["ignore", "pipe", "pipe"],
      env: (() => {
        const env: Record<string, string | undefined> = { ...process.env, HOME: process.env.HOME };
        delete env.CLAUDECODE;
        // Mark this as an unattended session (same convention as launchd wrappers).
        // Stop hooks like ssot-drift-guard use this to skip headless runs — without
        // it, hook-injected turns overwrite the real answer posted to Slack.
        env.CLAUDE_SESSION_ID = sessionIdForRun;
        // 認証は無人ジョブと同じ長期トークンで固定する（Keychain のリフレッシュに依存しない）
        if (!env.CLAUDE_CODE_OAUTH_TOKEN && !env.CLAUDE_CONFIG_DIR) {
          const tok = readLaunchdToken();
          if (tok) env.CLAUDE_CODE_OAUTH_TOKEN = tok;
        }
        return env;
      })(),
    });

    let buffer = "";
    let fullResult = "";
    let costUsd = 0;
    let sessionId: string | undefined;
    let stderr = "";
    let killed = false; // once timed out, stop forwarding progress to Slack

    child.stdout.on("data", (data: Buffer) => {
      if (killed) return;
      buffer += data.toString();

      // Process complete JSON lines
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // Keep incomplete last line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);

          if (event.type === "assistant" && event.message?.content) {
            // Extract text blocks from assistant message
            for (const block of event.message.content) {
              if (block.type === "text" && block.text) {
                fullResult = block.text;
                options?.onProgress?.(fullResult);
              }
            }
          } else if (event.type === "result") {
            // Final result event
            fullResult = event.result || fullResult;
            costUsd = event.total_cost_usd ?? 0;
            sessionId = event.session_id;

            if (!fullResult && event.subtype) {
              const reason =
                event.subtype === "error_max_turns"
                  ? "ターン上限に到達しました"
                  : event.subtype === "error_max_budget_usd"
                  ? "コスト上限に到達しました"
                  : `処理終了 (${event.subtype})`;
              fullResult = `⚠️ ${reason}`;
            }
          }
        } catch {
          // Ignore non-JSON lines
        }
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    // --- Timeout: global (absolute max) + idle (loose safety valve) ---
    // stream-json emits nothing while a tool call (esp. a subagent) is running,
    // so idle silence is normal for deep runs. The global timeout is the real limit.
    const timeoutMs = options?.timeoutMs ?? config.TIMEOUT_MS;
    const idleTimeoutMs = options?.idleTimeoutMs ?? config.IDLE_TIMEOUT_MS;

    const killWithTimeout = (label: string, ms: number) => {
      if (killed) return;
      killed = true;
      clearTimeout(globalTimer);
      clearTimeout(idleTimer);
      console.error(`[claude] ${label} after ${ms}ms — killing`);
      child.kill("SIGTERM");
      // Escalate to SIGKILL if the child ignores SIGTERM
      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          console.error(`[claude] SIGTERM ignored — sending SIGKILL`);
          child.kill("SIGKILL");
        }
      }, 10_000);
      killTimer.unref();
      reject(new Error(`タイムアウト: ${label} (${Math.round(ms / 1000)}秒)`));
    };

    const globalTimer = setTimeout(
      () => killWithTimeout("全体タイムアウト", timeoutMs),
      timeoutMs
    );

    let idleTimer = setTimeout(
      () => killWithTimeout("無応答タイムアウト", idleTimeoutMs),
      idleTimeoutMs
    );

    // Reset idle timer on any stdout activity
    child.stdout.on("data", () => {
      if (killed) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => killWithTimeout("無応答タイムアウト", idleTimeoutMs),
        idleTimeoutMs
      );
    });

    child.on("close", (code) => {
      clearTimeout(globalTimer);
      clearTimeout(idleTimer);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[claude] Finished in ${elapsed}s (exit=${code})`);

      if (killed) return; // already rejected by timeout — nothing more to do

      if (stderr) {
        console.error(`[claude] stderr: ${stderr.slice(0, 500)}`);
      }

      if (code !== 0 && !fullResult) {
        const detail = `${stderr.slice(0, 300)}`;
        if (AUTH_FAIL_RE.test(detail)) {
          return reject(new ClaudeAuthError(detail.trim() || "authentication failed"));
        }
        return reject(new Error(`Claude CLI exited with code ${code}\n${detail}`));
      }

      // 認証失敗は result 本文として返ってくることがある（exit=0・課金ゼロ・1行）。
      // これをそのまま Slack へ流すと、メンバーの見える面に内部エラーが出る
      if (costUsd === 0 && fullResult.length < 300 && AUTH_FAIL_RE.test(fullResult)) {
        return reject(new ClaudeAuthError(fullResult.trim()));
      }

      resolve({
        result: fullResult || "(empty)",
        costUsd,
        sessionId,
      });
    });

    child.on("error", (err) => {
      clearTimeout(globalTimer);
      clearTimeout(idleTimer);
      reject(new Error(`Claude CLI spawn error: ${err.message}`));
    });
  });
}
