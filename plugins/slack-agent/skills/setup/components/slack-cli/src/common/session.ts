// セッションID注入（SSOT）。
// 正本ルール: references/slack-post-rules.md
// 
//
// 挙動（fail-closed）:
//  - CLAUDE_SESSION_ID が供給されている場合:
//      1. payload 内の全文字列の `{SESSION_ID}` プレースホルダを実 ID へ置換
//      2. blocks に `claude --resume` 行が1つも無ければ、末尾に resume 用の
//         context ブロックを自動付与する（スキル側が付け忘れても必ず付く＝徹底）
//  - CLAUDE_SESSION_ID が未供給の場合:
//      - `claude --resume` を含む context 要素を除去し、空になった context ブロックを落とす
//      - 誤ったID・リテラル `{SESSION_ID}` を出さない（fail closed）
//
// top-level `payload.blocks` のみを対象にする（既存 slack-post.sh の jq ロジックと parity）。

const PLACEHOLDER = '{SESSION_ID}';
const RESUME_MARKER = 'claude --resume';

function isValidSessionId(id: string): boolean {
  // UUID 形式（launchd wrapper が uuidgen で供給する想定）。想定外文字列は fail closed 扱い。
  return /^[0-9a-fA-F-]{8,64}$/.test(id);
}

function deepReplacePlaceholder(value: unknown, sessionId: string): unknown {
  if (typeof value === 'string') {
    return value.split(PLACEHOLDER).join(sessionId);
  }
  if (Array.isArray(value)) {
    return value.map((v) => deepReplacePlaceholder(v, sessionId));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepReplacePlaceholder(v, sessionId);
    }
    return out;
  }
  return value;
}

function textOf(el: unknown): string {
  if (el && typeof el === 'object') {
    const t = (el as Record<string, unknown>).text;
    if (typeof t === 'string') return t;
  }
  return '';
}

function blocksHaveResumeLine(blocks: unknown[]): boolean {
  return blocks.some((b) => {
    if (!b || typeof b !== 'object') return false;
    const elements = (b as Record<string, unknown>).elements;
    if (!Array.isArray(elements)) return false;
    return elements.some((el) => textOf(el).includes(RESUME_MARKER));
  });
}

// context 要素を drop 条件でフィルタし、空になった context ブロックを丸ごと落とす。
// Slack API は elements 空の context ブロックを reject するため。
function filterContextElements(
  blocks: unknown[],
  shouldDrop: (text: string) => boolean,
): unknown[] {
  return blocks
    .map((b) => {
      if (!b || typeof b !== 'object') return b;
      const block = b as Record<string, unknown>;
      if (block.type !== 'context' || !Array.isArray(block.elements)) return b;
      const filtered = (block.elements as unknown[]).filter(
        (el) => !shouldDrop(textOf(el)),
      );
      return { ...block, elements: filtered };
    })
    .filter((b) => {
      if (!b || typeof b !== 'object') return true;
      const block = b as Record<string, unknown>;
      if (block.type !== 'context') return true;
      return Array.isArray(block.elements) && block.elements.length > 0;
    });
}

function resumeContextBlock(sessionId: string): Record<string, unknown> {
  return {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `\`claude --resume ${sessionId}\`` }],
  };
}

/**
 * payload を in-place ではなく破壊的に書き換え、セッションID注入を行う。
 * @param payload chat.postMessage 用ペイロード（parse 済み）
 * @param env セッションID供給元（テスト用に注入可能）
 */
export function injectSession(
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const raw = (env.CLAUDE_SESSION_ID ?? '').trim();
  const sessionId = isValidSessionId(raw) ? raw : '';

  if (sessionId) {
    // 1. プレースホルダ置換（後方互換）
    if (Array.isArray(payload.blocks)) {
      payload.blocks = deepReplacePlaceholder(payload.blocks, sessionId) as unknown[];
    }
    if (typeof payload.text === 'string') {
      payload.text = payload.text.split(PLACEHOLDER).join(sessionId);
    }
    // 2. resume 行が無ければ自動付与（付け忘れても必ず付く＝徹底）
    if (Array.isArray(payload.blocks)) {
      if (!blocksHaveResumeLine(payload.blocks)) {
        payload.blocks = [...payload.blocks, resumeContextBlock(sessionId)];
      }
    } else if (typeof payload.text === 'string' && !payload.text.includes(RESUME_MARKER)) {
      // blocks を持たない --text 送信も resume 行を末尾に付与する
      payload.text = `${payload.text}\n\n\`claude --resume ${sessionId}\``;
    }
    return;
  }

  // fail closed: 未供給時は resume 行・リテラルプレースホルダを出さない。
  if (Array.isArray(payload.blocks)) {
    // 「claude --resume」を含む要素・残存 `{SESSION_ID}` を除去し、空 context を落とす。
    payload.blocks = filterContextElements(
      payload.blocks,
      (text) => text.includes(RESUME_MARKER) || text.includes(PLACEHOLDER),
    );
  }
  if (typeof payload.text === 'string') {
    // resume スニペット `\`claude --resume ...\`` と残存プレースホルダを text から除去。
    payload.text = payload.text
      .replace(/\n*`claude --resume[^`]*`/g, '')
      .split(PLACEHOLDER)
      .join('')
      .replace(/\s+$/, '');
  }
}
