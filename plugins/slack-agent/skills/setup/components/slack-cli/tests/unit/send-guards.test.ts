import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractTextHead,
  registerThreadWatch,
  shouldRegisterThreadWatch,
  stripReplyBroadcast,
} from '../../src/write/send-guards.js';

const CC = 'cc: <@U000TEST01>';

describe('stripReplyBroadcast', () => {
  it('removes reply_broadcast: true and reports stripped', () => {
    const payload: Record<string, unknown> = {
      channel: 'C000CHAN01',
      thread_ts: '1786053287.923629',
      text: 'reply',
      reply_broadcast: true,
    };
    expect(stripReplyBroadcast(payload)).toBe(true);
    expect('reply_broadcast' in payload).toBe(false);
  });

  it('removes reply_broadcast: false silently', () => {
    const payload: Record<string, unknown> = { text: 'x', reply_broadcast: false };
    expect(stripReplyBroadcast(payload)).toBe(false);
    expect('reply_broadcast' in payload).toBe(false);
  });

  it('no-ops when key is absent', () => {
    const payload: Record<string, unknown> = { text: 'x' };
    expect(stripReplyBroadcast(payload)).toBe(false);
  });
});

describe('shouldRegisterThreadWatch', () => {
  beforeEach(() => {
    delete process.env.SLACK_THREAD_WATCH_DISABLE;
  });

  it('registers cc-marked root post to a normal channel', () => {
    const payload = { text: `<@U000PEER01> 大谷さん\n${CC}\n依頼です` };
    expect(shouldRegisterThreadWatch(payload, 'C000CHAN01')).toBe(true);
  });

  it('finds cc marker inside blocks', () => {
    const payload = {
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `<@U000PEER02> さん\n${CC}\n共有です` } },
      ],
    };
    expect(shouldRegisterThreadWatch(payload, 'C000CHAN02')).toBe(true);
  });

  it('ignores a cc marker that is not at the start of a line (quotes / pasted logs)', () => {
    expect(shouldRegisterThreadWatch({ text: `> ${CC}` }, 'C000CHAN01')).toBe(false);
    expect(shouldRegisterThreadWatch({ text: `過去ログ: ${CC} を付けた` }, 'C000CHAN01')).toBe(false);
  });

  it('fails closed when SLACK_MY_USER_ID is unset', () => {
    const saved = process.env.SLACK_MY_USER_ID;
    delete process.env.SLACK_MY_USER_ID;
    expect(shouldRegisterThreadWatch({ text: `${CC}\n依頼` }, 'C000CHAN01')).toBe(false);
    process.env.SLACK_MY_USER_ID = saved;
  });

  it('skips thread replies', () => {
    const payload = { text: `reply\n${CC}`, thread_ts: '1786054114.095989' };
    expect(shouldRegisterThreadWatch(payload, 'C000CHAN01')).toBe(false);
  });

  it('skips posts without cc marker', () => {
    const payload = { text: '<@U000PEER01> 依頼です' };
    expect(shouldRegisterThreadWatch(payload, 'C000CHAN01')).toBe(false);
  });

  it('skips dm.yuto and ops_log', () => {
    const payload = { text: `🔴 要対応\n${CC}` };
    expect(shouldRegisterThreadWatch(payload, 'D000TESTDM')).toBe(false);
    expect(shouldRegisterThreadWatch(payload, 'C000TESTLOG')).toBe(false);
  });

  it('honors SLACK_THREAD_WATCH_DISABLE=1', () => {
    process.env.SLACK_THREAD_WATCH_DISABLE = '1';
    const payload = { text: `x\n${CC}` };
    expect(shouldRegisterThreadWatch(payload, 'C000CHAN01')).toBe(false);
    delete process.env.SLACK_THREAD_WATCH_DISABLE;
  });
});

describe('extractTextHead', () => {
  it('joins text and block texts, collapses whitespace, caps at 200', () => {
    const payload = {
      text: 'fallback',
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: 'タイトル' } },
        { type: 'section', text: { type: 'mrkdwn', text: '本文\n2行目' } },
      ],
    };
    const head = extractTextHead(payload);
    expect(head).toBe('fallback タイトル 本文 2行目');
    expect(extractTextHead({ text: 'あ'.repeat(300) }).length).toBe(200);
  });
});

describe('registerThreadWatch', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-watch-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CLAUDE_SESSION_ID;
  });

  it('appends a JSONL event for a registerable post', () => {
    process.env.CLAUDE_SESSION_ID = '11111111-2222-3333-4444-555555555555';
    const eventsPath = path.join(tmpDir, 'nested', 'register-events.jsonl');
    const payload = { text: `<@U000PEER01> さん\n${CC}\nGTM依頼` };
    registerThreadWatch(payload, 'C000CHAN01', '1786054114.095989', eventsPath);
    registerThreadWatch(payload, 'C000CHAN01', '1786054999.000001', eventsPath);
    const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    const ev = JSON.parse(lines[0]);
    expect(ev.channel).toBe('C000CHAN01');
    expect(ev.thread_ts).toBe('1786054114.095989');
    expect(ev.session_id).toBe('11111111-2222-3333-4444-555555555555');
    expect(ev.text_head).toContain('GTM依頼');
    expect(typeof ev.registered_at).toBe('string');
  });

  it('writes nothing for non-registerable posts', () => {
    const eventsPath = path.join(tmpDir, 'register-events.jsonl');
    registerThreadWatch({ text: 'no marker' }, 'C000CHAN01', '1.0', eventsPath);
    expect(fs.existsSync(eventsPath)).toBe(false);
  });

  it('does not throw when the events path is unwritable (fail-open)', () => {
    const eventsPath = path.join(tmpDir, 'file-as-dir');
    fs.writeFileSync(eventsPath, 'x');
    const payload = { text: CC };
    expect(() =>
      registerThreadWatch(payload, 'C000CHAN01', '1.0', path.join(eventsPath, 'events.jsonl')),
    ).not.toThrow();
  });
});
