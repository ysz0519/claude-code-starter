import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { warn } from '../common/logger.js';

// reply_broadcast（Also sent to the channel）は投稿規約で禁止。
// 正本: references/slack-post-rules.md「スレッド返信で reply_broadcast を使わない」
// スレッド外の payload に付いていても意味を持たないため、無条件で除去する（ハード除去・投稿は継続）。
export function stripReplyBroadcast(payload: Record<string, unknown>): boolean {
  if (!('reply_broadcast' in payload)) return false;
  const wasTruthy = Boolean(payload.reply_broadcast);
  delete payload.reply_broadcast;
  if (wasTruthy) {
    warn(
      'send: reply_broadcast（Also sent to the channel）はルールで禁止です（投稿規約 slack-post-rules.md）。除去して送信します',
    );
  }
  return wasTruthy;
}

// スレッド返信キャッチアップ（slack-thread-catchup）の監視自動登録。
// 自分の Bot が「自分以外の相手」に宛てたルート投稿を送信層で検出し、登録イベントを JSONL に残す。
// 判別キーは cc ルール（投稿規約「自分以外への投稿は cc: @自分 を付ける」）のマーカー。
//
// 設定は env から取る（配布版・個人依存値を持たない）:
//   SLACK_MY_USER_ID     … 自分の Slack ユーザーID（例 U01234567）。cc マーカーの生成に使う
//   SLACK_WATCH_EXCLUDE  … 監視対象外チャンネルID のカンマ区切り（自分の DM / ops_log 等）
// env は import 時ではなく呼び出し時に読む（設定ロードの順序に依存しないため）
function ccMarker(): string {
  const myUserId = (process.env.SLACK_MY_USER_ID ?? '').trim();
  return myUserId ? `cc: <@${myUserId}>` : '';
}

// 自分宛の DM / ops_log は自分自身が読む通知のため監視対象外
function excludedChannels(): Set<string> {
  return new Set(
    (process.env.SLACK_WATCH_EXCLUDE ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export const REGISTER_EVENTS_PATH = path.join(
  os.homedir(),
  '.claude',
  'state',
  'slack-thread-catchup',
  'register-events.jsonl',
);

export function extractTextHead(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof payload.text === 'string' && payload.text.length > 0) {
    parts.push(payload.text);
  }
  if (Array.isArray(payload.blocks)) {
    for (const b of payload.blocks as any[]) {
      const t = b?.text?.text;
      if (typeof t === 'string' && t.length > 0) parts.push(t);
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').slice(0, 200);
}

export function shouldRegisterThreadWatch(
  payload: Record<string, unknown>,
  channel: string,
): boolean {
  if (process.env.SLACK_THREAD_WATCH_DISABLE === '1') return false;
  // SLACK_MY_USER_ID 未設定なら cc マーカーを作れない → 何も登録しない（fail-closed）。
  // ここを空文字のまま includes() に渡すと全投稿が監視対象になるため必須のガード。
  const marker = ccMarker();
  if (!marker) return false;
  // スレッド返信は登録しない（監視対象はルート投稿のみ）
  if (payload.thread_ts) return false;
  if (excludedChannels().has(channel)) return false;
  // cc マーカーは text / blocks のどこにあってもよいが、**独立した行の先頭**に限る。
  // 単純な部分一致だと、引用（> cc: ...）や貼り付けた過去ログの中の cc でも登録され、
  // 意図しない監視が fail-open で増える（Codex 指摘 MEDIUM・2026-08-12）。
  const raw =
    `${typeof payload.text === 'string' ? payload.text : ''}\n` +
    `${payload.blocks ? JSON.stringify(payload.blocks) : ''}`;
  // JSON.stringify は実改行を "\n" の2文字へ変換するため、両方を行区切りとして扱う
  const haystack = raw.split('\\n').join('\n');
  return haystack
    .split('\n')
    .some((line) => line.trimStart().startsWith(marker));
}

export interface ThreadWatchEvent {
  channel: string;
  thread_ts: string;
  text_head: string;
  session_id: string | null;
  registered_at: string;
}

// 送信成功後に登録イベントを追記する。失敗しても送信自体は成功扱い（fail-open・warn のみ）。
// O_APPEND の単一 write（appendFileSync）で実用上 atomic（workspace-tracker-posttools.sh と同方式）。
export function registerThreadWatch(
  payload: Record<string, unknown>,
  channel: string,
  postedTs: string,
  eventsPath: string = REGISTER_EVENTS_PATH,
): void {
  try {
    if (!shouldRegisterThreadWatch(payload, channel)) return;
    const event: ThreadWatchEvent = {
      channel,
      thread_ts: postedTs,
      text_head: extractTextHead(payload),
      session_id: process.env.CLAUDE_SESSION_ID || null,
      registered_at: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
    fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, 'utf8');
  } catch (err: any) {
    warn(
      `send: thread-watch 登録に失敗しました（送信は成功・監視のみ未登録）: ${err?.message ?? 'unknown'}`,
    );
  }
}
