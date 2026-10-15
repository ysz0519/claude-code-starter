import { describe, expect, it } from 'vitest';
import { injectSession } from '../../src/common/session.js';

const SID = '11111111-2222-3333-4444-555555555555';

function ctx(text: string) {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

describe('injectSession', () => {
  it('replaces {SESSION_ID} placeholder when env supplied', () => {
    const payload: Record<string, unknown> = {
      blocks: [ctx('`claude --resume {SESSION_ID}`')],
    };
    injectSession(payload, { CLAUDE_SESSION_ID: SID } as NodeJS.ProcessEnv);
    const blocks = payload.blocks as any[];
    expect(blocks[0].elements[0].text).toBe(`\`claude --resume ${SID}\``);
  });

  it('auto-appends a resume context block when none exists', () => {
    const payload: Record<string, unknown> = {
      blocks: [{ type: 'header', text: { type: 'plain_text', text: '🟢 done' } }],
    };
    injectSession(payload, { CLAUDE_SESSION_ID: SID } as NodeJS.ProcessEnv);
    const blocks = payload.blocks as any[];
    expect(blocks).toHaveLength(2);
    expect(blocks[1].type).toBe('context');
    expect(blocks[1].elements[0].text).toBe(`\`claude --resume ${SID}\``);
  });

  it('does NOT duplicate resume line when one already exists', () => {
    const payload: Record<string, unknown> = {
      blocks: [ctx('📄 `/path/file.md`'), ctx('`claude --resume {SESSION_ID}`')],
    };
    injectSession(payload, { CLAUDE_SESSION_ID: SID } as NodeJS.ProcessEnv);
    const blocks = payload.blocks as any[];
    // 2 blocks preserved, placeholder substituted, no 3rd appended
    expect(blocks).toHaveLength(2);
    expect(blocks[1].elements[0].text).toBe(`\`claude --resume ${SID}\``);
  });

  it('fail-closed: strips resume element when env unset', () => {
    const payload: Record<string, unknown> = {
      blocks: [ctx('📄 `/path/file.md`'), ctx('`claude --resume {SESSION_ID}`')],
    };
    injectSession(payload, {} as NodeJS.ProcessEnv);
    const blocks = payload.blocks as any[];
    // resume-only context block dropped entirely (empty elements removed)
    expect(blocks).toHaveLength(1);
    expect(blocks[0].elements[0].text).toBe('📄 `/path/file.md`');
  });

  it('fail-closed: removes literal placeholder from mixed context element', () => {
    const payload: Record<string, unknown> = {
      blocks: [
        { type: 'context', elements: [{ type: 'mrkdwn', text: '{SESSION_ID}' }] },
      ],
    };
    injectSession(payload, {} as NodeJS.ProcessEnv);
    const blocks = payload.blocks as any[];
    // empty context block dropped
    expect(blocks).toHaveLength(0);
  });

  it('fail-closed: does not auto-append when env unset', () => {
    const payload: Record<string, unknown> = {
      blocks: [{ type: 'header', text: { type: 'plain_text', text: '🟢 done' } }],
    };
    injectSession(payload, {} as NodeJS.ProcessEnv);
    expect((payload.blocks as any[]).length).toBe(1);
  });

  it('treats malformed session id as unset (fail closed)', () => {
    const payload: Record<string, unknown> = {
      blocks: [{ type: 'header', text: { type: 'plain_text', text: '🟢 done' } }],
    };
    injectSession(payload, { CLAUDE_SESSION_ID: 'not a uuid!!' } as NodeJS.ProcessEnv);
    expect((payload.blocks as any[]).length).toBe(1);
  });

  it('appends resume line to text-only payloads when env supplied', () => {
    const payload: Record<string, unknown> = { channel: 'C1', text: 'hello' };
    injectSession(payload, { CLAUDE_SESSION_ID: SID } as NodeJS.ProcessEnv);
    expect(payload.text).toBe(`hello\n\n\`claude --resume ${SID}\``);
  });

  it('substitutes {SESSION_ID} in text without double-appending', () => {
    const payload: Record<string, unknown> = {
      channel: 'C1',
      text: 'hello `claude --resume {SESSION_ID}`',
    };
    injectSession(payload, { CLAUDE_SESSION_ID: SID } as NodeJS.ProcessEnv);
    expect(payload.text).toBe(`hello \`claude --resume ${SID}\``);
  });

  it('fail-closed: strips resume snippet from text when env unset', () => {
    const payload: Record<string, unknown> = {
      channel: 'C1',
      text: 'alert body\n\n`claude --resume {SESSION_ID}`',
    };
    injectSession(payload, {} as NodeJS.ProcessEnv);
    expect(payload.text).toBe('alert body');
  });

  it('leaves plain text untouched when env unset', () => {
    const payload: Record<string, unknown> = { channel: 'C1', text: 'plain alert' };
    injectSession(payload, {} as NodeJS.ProcessEnv);
    expect(payload.text).toBe('plain alert');
  });
});
