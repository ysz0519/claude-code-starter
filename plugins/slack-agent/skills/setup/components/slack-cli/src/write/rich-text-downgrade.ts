// rich_text ブロックの section(mrkdwn) ダウングレード。
// 正本ルール: references/slack-post-rules.md「本文は Block Kit で書く」
//
// 用途: chat.postMessage が invalid_blocks を返し、payload に rich_text ブロックが
// 含まれる場合に、rich_text → section（行頭 ・ / 1. の mrkdwn）へ変換して1回だけ
// リトライする（無人 launchd 投稿を JSON 生成ミスで丸ごと失敗させないための保険）。
//
// 変換は「読める形で必ず届く」ことを優先し、不正な構造は optional chaining で
// 読める範囲だけ拾う（throw しない）。

const SECTION_TEXT_LIMIT = 3000; // Slack section.text の上限

interface AnyObj {
  [key: string]: unknown;
}

function asObj(v: unknown): AnyObj | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyObj) : null;
}

function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

// リテラル文字列の mrkdwn エスケープ（誤メンション・誤リンク化防止。
// rich_text の text 要素はリテラル扱いなので `<!here>` 等をそのまま mrkdwn に
// 落とすと発火してしまう）
function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// rich_text_section 等の inline 要素1個 → mrkdwn 文字列
function renderInlineElement(el: unknown): string {
  const o = asObj(el);
  if (!o) return '';
  switch (o.type) {
    case 'text': {
      const text = typeof o.text === 'string' ? escapeMrkdwn(o.text) : '';
      const style = asObj(o.style);
      // ダウングレード時は style.bold を無視して素の文にする（mrkdwn へ落ちるため）
      if (style?.code === true && text.length > 0) return `\`${text}\``;
      return text;
    }
    case 'link': {
      const url = typeof o.url === 'string' ? o.url : '';
      const rawLabel = typeof o.text === 'string' && o.text.length > 0 ? o.text : url;
      const label = escapeMrkdwn(rawLabel).replace(/\|/g, '｜');
      if (!url) return label;
      return `<${url}|${label}>`;
    }
    case 'emoji':
      return typeof o.name === 'string' ? `:${o.name}:` : '';
    case 'user':
      return typeof o.user_id === 'string' ? `<@${o.user_id}>` : '';
    case 'usergroup':
      return typeof o.usergroup_id === 'string' ? `<!subteam^${o.usergroup_id}>` : '';
    case 'channel':
      return typeof o.channel_id === 'string' ? `<#${o.channel_id}>` : '';
    case 'broadcast':
      return typeof o.range === 'string' ? `<!${o.range}>` : '';
    default:
      // 未知要素: text フィールドがあれば拾う（リテラル扱いでエスケープ）
      return typeof o.text === 'string' ? escapeMrkdwn(o.text) : '';
  }
}

function renderInlineElements(elements: unknown): string {
  return asArr(elements).map(renderInlineElement).join('');
}

// rich_text 直下の要素（rich_text_section / rich_text_list / …）→ mrkdwn 行の配列
function renderRichTextElement(el: unknown): string[] {
  const o = asObj(el);
  if (!o) return [];
  switch (o.type) {
    case 'rich_text_section': {
      const text = renderInlineElements(o.elements);
      return text.length > 0 ? [text] : [];
    }
    case 'rich_text_list': {
      const ordered = o.style === 'ordered';
      const indentLevel = typeof o.indent === 'number' && o.indent > 0 ? o.indent : 0;
      const pad = '  '.repeat(indentLevel);
      return asArr(o.elements).flatMap((item, i) => {
        const itemObj = asObj(item);
        const text = renderInlineElements(itemObj?.elements);
        if (text.length === 0) return [];
        const bullet = ordered ? `${i + 1}. ` : '・';
        return [`${pad}${bullet}${text}`];
      });
    }
    case 'rich_text_preformatted': {
      const text = renderInlineElements(o.elements);
      return text.length > 0 ? ['```', text, '```'] : [];
    }
    case 'rich_text_quote': {
      const text = renderInlineElements(o.elements);
      return text.length > 0 ? [`> ${text}`] : [];
    }
    default:
      return [];
  }
}

export function hasRichTextBlocks(blocks: unknown): boolean {
  return asArr(blocks).some((b) => asObj(b)?.type === 'rich_text');
}

/**
 * blocks 配列中の rich_text ブロックを section(mrkdwn) へ変換した新配列を返す。
 * rich_text 以外のブロックはそのまま。内容を1文字も復元できない rich_text は落とす。
 */
export function downgradeRichTextBlocks(blocks: unknown[]): unknown[] {
  return blocks
    .map((b) => {
      const o = asObj(b);
      if (!o || o.type !== 'rich_text') return b;
      const lines = asArr(o.elements).flatMap(renderRichTextElement);
      const text = lines.join('\n').slice(0, SECTION_TEXT_LIMIT);
      if (text.trim().length === 0) return null;
      return { type: 'section', text: { type: 'mrkdwn', text } };
    })
    .filter((b): b is NonNullable<typeof b> => b !== null);
}
