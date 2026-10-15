import fs from 'node:fs';
import { makeWebClient } from '../common/client.js';
import { ExitCode, SlackCliError } from '../common/errors.js';
import { log, warn } from '../common/logger.js';
import { withRetry } from '../common/rate-limit.js';
import { injectSession } from '../common/session.js';
import { verifyTokenKind } from '../common/token.js';
import {
  downgradeRichTextBlocks,
  hasRichTextBlocks,
} from './rich-text-downgrade.js';
import { registerThreadWatch, stripReplyBroadcast } from './send-guards.js';

export interface SendOptions {
  channel: string;
  jsonFile?: string;
  text?: string;
  keep?: boolean;
}

interface BlockKitPayload {
  channel?: string;
  text?: string;
  blocks?: unknown;
  attachments?: unknown;
  thread_ts?: string;
  reply_broadcast?: boolean;
  unfurl_links?: boolean;
  unfurl_media?: boolean;
  [key: string]: unknown;
}

// 通知タイトル文法 lint（warn-only・非ブロック）。正本: references/slack-post-rules.md「タイトル文法と severity」
const SEVERITY_EMOJIS = ['🔴', '🟡', '🟢', '🔵'];

function lintHeaderGrammar(payload: BlockKitPayload): void {
  if (!Array.isArray(payload.blocks)) return;
  const header = (payload.blocks as any[]).find((b) => b?.type === 'header');
  const headerText: string | undefined = header?.text?.text;
  if (typeof headerText !== 'string' || headerText.length === 0) return;
  const trimmed = headerText.trimStart();
  if (trimmed.startsWith('[')) {
    warn(
      `send: header は旧形式です（[skill-name] 先頭）。新文法「{🔴|🟡|🟢|🔵} {結論}｜{ラベル}」に移行し、marker は1つ目の section へ（投稿規約 slack-post-rules.md 参照）: "${headerText}"`,
    );
    return;
  }
  if (!SEVERITY_EMOJIS.some((e) => trimmed.startsWith(e))) {
    warn(
      `send: header 先頭が状態絵文字（🔴/🟡/🟢/🔵）ではありません。新文法「{絵文字} {結論}｜{ラベル}」を推奨（投稿規約 slack-post-rules.md 参照）: "${headerText}"`,
    );
    return;
  }
  // severity ルーティング lint（warn-only）: 🟢正常完了/🔵定期レポートは ops_log（C チャンネル）行き。
  // DM（D...）に送ろうとしていたら警告する（投稿規約「タイトル文法と severity」）
  const channel = typeof payload.channel === 'string' ? payload.channel : '';
  if ((trimmed.startsWith('🟢') || trimmed.startsWith('🔵')) && channel.startsWith('D')) {
    const opsLog = (process.env.SLACK_OPS_LOG_CHANNEL ?? '').trim();
    const hint = opsLog ? `ops_log（${opsLog}）` : 'ops_log チャンネル（env: SLACK_OPS_LOG_CHANNEL）';
    warn(
      `send: 🟢/🔵（正常完了・定期レポート）は DM ではなく ${hint} へ投稿してください（投稿規約 severity ルーティング）: "${headerText}" → channel=${channel}`,
    );
  }
}

export async function cmdSend(opts: SendOptions): Promise<void> {
  if (!opts.jsonFile && !opts.text) {
    throw new SlackCliError(
      'send: either --json-file or --text is required',
      ExitCode.User,
    );
  }
  if (opts.jsonFile && opts.text) {
    throw new SlackCliError(
      'send: --json-file and --text are mutually exclusive',
      ExitCode.User,
    );
  }

  const client = makeWebClient('bot');
  await verifyTokenKind(client, 'bot');

  let payload: BlockKitPayload;
  if (opts.jsonFile) {
    let raw: string;
    try {
      raw = fs.readFileSync(opts.jsonFile, 'utf8');
    } catch (err: any) {
      throw new SlackCliError(
        `send: failed to read --json-file: ${opts.jsonFile} (${err?.code ?? err?.message ?? 'unknown'})`,
        ExitCode.User,
      );
    }
    try {
      payload = JSON.parse(raw) as BlockKitPayload;
    } catch (err: any) {
      throw new SlackCliError(
        `send: --json-file is not valid JSON: ${err?.message ?? 'unknown'}`,
        ExitCode.User,
      );
    }
    payload.channel = opts.channel;
    // セッションID注入（SSOT）: {SESSION_ID} 置換 + resume 行の自動付与 / fail-closed 除去。
    // 正本: references/slack-post-rules.md
    injectSession(payload as Record<string, unknown>);
    lintHeaderGrammar(payload);
  } else {
    payload = { channel: opts.channel, text: opts.text };
    injectSession(payload as Record<string, unknown>);
  }
  // reply_broadcast（Also sent to the channel）は投稿規約で禁止 → 機械除去
  stripReplyBroadcast(payload as Record<string, unknown>);

  // rich_text ダウングレード付き投稿（正本: references/slack-post-rules.md）。
  // invalid_blocks かつ rich_text ブロックを含む場合のみ、section(・) へ変換して1回リトライ。
  let res;
  try {
    res = await withRetry(() => client.chat.postMessage(payload as any));
  } catch (err: any) {
    const apiError = err?.data?.error as string | undefined;
    const isInvalidBlocks =
      apiError === 'invalid_blocks' || apiError === 'invalid_blocks_format';
    if (isInvalidBlocks && hasRichTextBlocks(payload.blocks)) {
      warn(
        'send: invalid_blocks を検知。rich_text ブロックを section(・) へ自動ダウングレードして再送します（JSON 生成ミスの可能性・生成元スキルを確認してください）',
      );
      payload.blocks = downgradeRichTextBlocks(payload.blocks as unknown[]);
      res = await withRetry(() => client.chat.postMessage(payload as any));
    } else {
      throw err;
    }
  }

  // 自分以外の相手への cc 付きルート投稿はスレッド監視へ自動登録（slack-thread-catchup・fail-open）
  if (typeof res.ts === 'string') {
    registerThreadWatch(
      payload as Record<string, unknown>,
      opts.channel,
      res.ts,
    );
  }

  if (opts.jsonFile && !opts.keep) {
    try {
      fs.unlinkSync(opts.jsonFile);
    } catch (err: any) {
      log(`send: failed to unlink --json-file: ${opts.jsonFile} (${err?.code ?? err?.message ?? 'unknown'})`);
    }
  }

  process.stdout.write(
    JSON.stringify({
      ok: true,
      channel: res.channel,
      ts: res.ts,
    }) + '\n',
  );
}
