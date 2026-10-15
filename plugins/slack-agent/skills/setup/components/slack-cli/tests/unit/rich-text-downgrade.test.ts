import { describe, expect, it } from 'vitest';
import {
  downgradeRichTextBlocks,
  hasRichTextBlocks,
} from '../../src/write/rich-text-downgrade.js';

const richTextBody = {
  type: 'rich_text',
  elements: [
    {
      type: 'rich_text_section',
      elements: [{ type: 'text', text: '[x-daily-ops]' }],
    },
    {
      type: 'rich_text_list',
      style: 'bullet',
      elements: [
        {
          type: 'rich_text_section',
          elements: [{ type: 'text', text: '結論: 消費¥20,570／CPA¥20,570' }],
        },
        {
          type: 'rich_text_section',
          elements: [{ type: 'text', text: '理由: 勝ち軸が本日1件' }],
        },
      ],
    },
  ],
};

describe('hasRichTextBlocks', () => {
  it('rich_text ブロックを検知する', () => {
    expect(hasRichTextBlocks([{ type: 'header' }, richTextBody])).toBe(true);
  });

  it('rich_text が無ければ false', () => {
    expect(hasRichTextBlocks([{ type: 'section' }])).toBe(false);
    expect(hasRichTextBlocks(undefined)).toBe(false);
    expect(hasRichTextBlocks('not-an-array')).toBe(false);
  });
});

describe('downgradeRichTextBlocks', () => {
  it('rich_text_list を ・ 付き section(mrkdwn) に変換する', () => {
    const out = downgradeRichTextBlocks([richTextBody]) as any[];
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('section');
    expect(out[0].text.type).toBe('mrkdwn');
    expect(out[0].text.text).toBe(
      '[x-daily-ops]\n・結論: 消費¥20,570／CPA¥20,570\n・理由: 勝ち軸が本日1件',
    );
  });

  it('ordered リストは 1. 2. で番号を振る', () => {
    const out = downgradeRichTextBlocks([
      {
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_list',
            style: 'ordered',
            elements: [
              { type: 'rich_text_section', elements: [{ type: 'text', text: 'いち' }] },
              { type: 'rich_text_section', elements: [{ type: 'text', text: 'に' }] },
            ],
          },
        ],
      },
    ]) as any[];
    expect(out[0].text.text).toBe('1. いち\n2. に');
  });

  it('rich_text 以外のブロックはそのまま残す', () => {
    const header = { type: 'header', text: { type: 'plain_text', text: '🔵 テスト' } };
    const context = { type: 'context', elements: [{ type: 'mrkdwn', text: '詳細: x.md' }] };
    const out = downgradeRichTextBlocks([header, richTextBody, context]) as any[];
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(header);
    expect(out[2]).toBe(context);
    expect(out[1].type).toBe('section');
  });

  it('link / code / emoji / user を mrkdwn に変換する', () => {
    const out = downgradeRichTextBlocks([
      {
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [
              { type: 'link', url: 'https://example.com', text: '例' },
              { type: 'text', text: ' と ' },
              { type: 'text', text: 'code', style: { code: true } },
              { type: 'emoji', name: 'tada' },
              { type: 'user', user_id: 'U000TEST01' },
            ],
          },
        ],
      },
    ]) as any[];
    expect(out[0].text.text).toBe('<https://example.com|例> と `code`:tada:<@U000TEST01>');
  });

  it('壊れた構造でも throw せず、復元できない rich_text は落とす', () => {
    const out = downgradeRichTextBlocks([
      { type: 'rich_text' }, // elements 欠落
      { type: 'rich_text', elements: [{ type: 'rich_text_section' }] }, // 中身空
      { type: 'rich_text', elements: 'broken' },
      { type: 'section', text: { type: 'mrkdwn', text: '生存' } },
    ]) as any[];
    // 復元不能な rich_text 3件は落ち、section はそのまま
    expect(out).toHaveLength(1);
    expect(out[0].text.text).toBe('生存');
  });

  it('リテラル text の < > & をエスケープし誤メンション・誤リンク化を防ぐ', () => {
    const out = downgradeRichTextBlocks([
      {
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [{ type: 'text', text: '<!here> A&B <url>' }],
          },
        ],
      },
    ]) as any[];
    expect(out[0].text.text).toBe('&lt;!here&gt; A&amp;B &lt;url&gt;');
  });

  it('style.bold は無視して素の文にする（太字禁止ルール）', () => {
    const out = downgradeRichTextBlocks([
      {
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [{ type: 'text', text: '強調', style: { bold: true } }],
          },
        ],
      },
    ]) as any[];
    expect(out[0].text.text).toBe('強調');
  });
});
