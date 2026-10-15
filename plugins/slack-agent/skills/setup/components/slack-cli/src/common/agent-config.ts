// 配布版の設定ロード（副作用 import）。
//
// slack-cli は Claude Code の Bash ツールから素で起動されるため、シェルの環境変数に頼れない。
// 個人ごとの設定（自分の Slack ユーザーID・Bot ハンドル・監視対象外チャンネル）は
// ~/.claude/.env.claude-slack-agent に置き、CLI 起動時にここで process.env へ流し込む。
//
// 既に環境変数が設定されている場合はそちらを優先する（呼び出し側で一時的に上書きできる）。
// ファイルが無い場合は何もしない（fail-open。トークンの読み込みは common/token.ts が別途行う）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const AGENT_CONFIG_FILENAME = '.env.claude-slack-agent';

/** 配布版が参照する設定キー（これ以外はファイルにあっても無視する） */
const ALLOWED_KEYS = new Set([
  'SLACK_MY_USER_ID',
  'SLACK_BOT_HANDLE',
  'SLACK_WATCH_EXCLUDE',
  'SLACK_OPS_LOG_CHANNEL',
  'SLACK_WORKSPACE_URL',
]);

export function agentConfigPath(): string {
  return path.join(process.env['HOME'] ?? os.homedir(), '.claude', AGENT_CONFIG_FILENAME);
}

function stripValue(raw: string): string {
  let v = raw.trim();
  if (!/^["']/.test(v)) {
    const i = v.search(/\s+#/);
    if (i >= 0) v = v.slice(0, i).trim();
  }
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1);
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    // setup.sh は bash の source 用に '\'' でシングルクォートを退避する
    return v.slice(1, -1).split("'\\''").join("'");
  }
  return v;
}

export function loadAgentConfig(file = agentConfigPath()): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return; // 未設定でも CLI 自体は動く（監視自動登録が無効になるだけ）
  }
  for (const line of raw.split('\n')) {
    let t = line.trim();
    if (t.startsWith('export ')) t = t.slice('export '.length).trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    if (!ALLOWED_KEYS.has(key)) continue;
    if (process.env[key]) continue; // 既存の環境変数を優先
    process.env[key] = stripValue(t.slice(eq + 1));
  }
}

loadAgentConfig();
