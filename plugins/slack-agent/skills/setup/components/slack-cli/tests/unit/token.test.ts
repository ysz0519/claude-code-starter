import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExitCode, SlackCliError } from '../../src/common/errors.js';
import {
  parseTokenValue,
  resolveToken,
  tokenFilePath,
  verifyTokenKind,
} from '../../src/common/token.js';

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-cli-token-'));
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  originalHome = process.env['HOME'];
  process.env['HOME'] = tmpHome;
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env['HOME'];
  } else {
    process.env['HOME'] = originalHome;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('tokenFilePath', () => {
  it('returns ~/.claude/.env.slack-cli.bot for bot', () => {
    expect(tokenFilePath('bot')).toBe(
      path.join(tmpHome, '.claude', '.env.slack-cli.bot'),
    );
  });

  it('returns ~/.claude/.env.slack-cli.user for user', () => {
    expect(tokenFilePath('user')).toBe(
      path.join(tmpHome, '.claude', '.env.slack-cli.user'),
    );
  });
});

describe('parseTokenValue', () => {
  it('returns the raw value when no quotes or comments are present', () => {
    expect(parseTokenValue('xoxb-plain-token')).toBe('xoxb-plain-token');
  });

  it('trims surrounding whitespace', () => {
    expect(parseTokenValue('  xoxb-trim  ')).toBe('xoxb-trim');
  });

  it('strips double quotes', () => {
    expect(parseTokenValue('"xoxb-double"')).toBe('xoxb-double');
  });

  it('strips single quotes', () => {
    expect(parseTokenValue("'xoxb-single'")).toBe('xoxb-single');
  });

  it('strips inline comments outside of quotes', () => {
    expect(parseTokenValue('xoxb-with-comment # prod token')).toBe(
      'xoxb-with-comment',
    );
  });

  it('preserves "#" characters inside a quoted value', () => {
    expect(parseTokenValue('"xoxb-with#hash # comment"')).toBe(
      'xoxb-with#hash # comment',
    );
  });

  it('does not strip mismatched quotes', () => {
    expect(parseTokenValue('"xoxb-mismatched')).toBe('"xoxb-mismatched');
  });
});

describe('resolveToken', () => {
  it('returns the bot token when the file exists', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.claude', '.env.slack-cli.bot'),
      'SLACK_BOT_TOKEN=xoxb-test-bot\n',
      { mode: 0o600 },
    );
    expect(resolveToken('bot')).toBe('xoxb-test-bot');
  });

  it('returns the user token when the file exists', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.claude', '.env.slack-cli.user'),
      'SLACK_USER_TOKEN=xoxp-test-user\n',
      { mode: 0o600 },
    );
    expect(resolveToken('user')).toBe('xoxp-test-user');
  });

  it('throws SlackCliError with Auth exit code when the file is missing', () => {
    try {
      resolveToken('bot');
      expect.fail('expected SlackCliError');
    } catch (err) {
      expect(err).toBeInstanceOf(SlackCliError);
      expect((err as SlackCliError).exitCode).toBe(ExitCode.Auth);
      expect((err as SlackCliError).message).toMatch(/Token file not found/);
    }
  });

  it('throws SlackCliError with Auth exit code when the expected key is missing', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.claude', '.env.slack-cli.bot'),
      'SOMETHING_ELSE=xyz\n',
    );
    try {
      resolveToken('bot');
      expect.fail('expected SlackCliError');
    } catch (err) {
      expect(err).toBeInstanceOf(SlackCliError);
      expect((err as SlackCliError).exitCode).toBe(ExitCode.Auth);
      expect((err as SlackCliError).message).toMatch(/SLACK_BOT_TOKEN not found/);
    }
  });

  it('reads only the matching key when the file has multiple lines', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.claude', '.env.slack-cli.user'),
      'SLACK_BOT_TOKEN=xoxb-wrong\nSLACK_USER_TOKEN=xoxp-correct\n',
    );
    expect(resolveToken('user')).toBe('xoxp-correct');
  });

  it('strips surrounding double quotes (standard dotenv format)', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.claude', '.env.slack-cli.bot'),
      'SLACK_BOT_TOKEN="xoxb-quoted-token"\n',
    );
    expect(resolveToken('bot')).toBe('xoxb-quoted-token');
  });

  it('strips inline comments after the token value', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.claude', '.env.slack-cli.bot'),
      'SLACK_BOT_TOKEN=xoxb-with-comment # production\n',
    );
    expect(resolveToken('bot')).toBe('xoxb-with-comment');
  });

  it('throws Auth error when the value is empty after stripping', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.claude', '.env.slack-cli.bot'),
      'SLACK_BOT_TOKEN=""\n',
    );
    expect(() => resolveToken('bot')).toThrow(/empty value/);
  });
});

describe('verifyTokenKind', () => {
  it('passes when expected=bot and auth.test returns bot_id', async () => {
    const fakeClient = {
      auth: { test: vi.fn().mockResolvedValue({ ok: true, bot_id: 'B123' }) },
    } as any;
    await expect(verifyTokenKind(fakeClient, 'bot')).resolves.toBeUndefined();
  });

  it('passes when expected=user and auth.test returns no bot_id', async () => {
    const fakeClient = {
      auth: { test: vi.fn().mockResolvedValue({ ok: true, user_id: 'U123' }) },
    } as any;
    await expect(verifyTokenKind(fakeClient, 'user')).resolves.toBeUndefined();
  });

  it('throws Auth error when expected=bot but token is user', async () => {
    const fakeClient = {
      auth: { test: vi.fn().mockResolvedValue({ ok: true, user_id: 'U123' }) },
    } as any;
    await expect(verifyTokenKind(fakeClient, 'bot')).rejects.toMatchObject({
      name: 'SlackCliError',
      exitCode: ExitCode.Auth,
      message: expect.stringMatching(/Expected Bot Token/),
    });
  });

  it('throws Auth error when expected=user but token is bot', async () => {
    const fakeClient = {
      auth: { test: vi.fn().mockResolvedValue({ ok: true, bot_id: 'B123' }) },
    } as any;
    await expect(verifyTokenKind(fakeClient, 'user')).rejects.toMatchObject({
      name: 'SlackCliError',
      exitCode: ExitCode.Auth,
      message: expect.stringMatching(/Expected User Token/),
    });
  });

  it('wraps auth.test API errors with Auth exit code', async () => {
    const fakeClient = {
      auth: {
        test: vi.fn().mockRejectedValue({ data: { error: 'invalid_auth' } }),
      },
    } as any;
    await expect(verifyTokenKind(fakeClient, 'bot')).rejects.toMatchObject({
      name: 'SlackCliError',
      exitCode: ExitCode.Auth,
      message: expect.stringMatching(/invalid_auth/),
    });
  });
});
