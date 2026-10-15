import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockClient = {
  auth: { test: vi.fn() },
  files: {
    getUploadURLExternal: vi.fn(),
    completeUploadExternal: vi.fn(),
  },
};

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn(() => mockClient),
}));

let tmpHome: string;
let originalHome: string | undefined;
let tmpFile: string;
let fetchSpy: ReturnType<typeof vi.fn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-cli-snippet-'));
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpHome, '.claude', '.env.slack-cli.bot'),
    'SLACK_BOT_TOKEN=xoxb-test-bot\n',
    { mode: 0o600 },
  );
  originalHome = process.env['HOME'];
  process.env['HOME'] = tmpHome;

  tmpFile = path.join(tmpHome, 'sample.md');
  fs.writeFileSync(tmpFile, '# Hello snippet\n');

  mockClient.auth.test.mockReset().mockResolvedValue({ ok: true, bot_id: 'B123' });
  mockClient.files.getUploadURLExternal.mockReset();
  mockClient.files.completeUploadExternal.mockReset();

  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);

  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env['HOME'];
  } else {
    process.env['HOME'] = originalHome;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.unstubAllGlobals();
  stdoutSpy.mockRestore();
});

describe('cmdSnippet', () => {
  it('executes the 3-stage upload flow and prints permalink', async () => {
    mockClient.files.getUploadURLExternal.mockResolvedValue({
      ok: true,
      upload_url: 'https://files.slack.com/upload/v1/ABC',
      file_id: 'F999',
    });
    fetchSpy.mockResolvedValue({ ok: true, status: 200 } as Response);
    mockClient.files.completeUploadExternal.mockResolvedValue({
      ok: true,
      files: [
        { id: 'F999', name: 'sample.md', permalink: 'https://overflow.slack.com/files/F999' },
      ],
    });

    const { cmdSnippet } = await import('../../src/write/snippet.js');
    await cmdSnippet({ channel: 'C12345', file: tmpFile, comment: 'check' });

    expect(mockClient.files.getUploadURLExternal).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'sample.md', length: 16 }),
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://files.slack.com/upload/v1/ABC',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(mockClient.files.completeUploadExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: 'C12345',
        initial_comment: 'check',
        files: [{ id: 'F999', title: 'sample.md' }],
      }),
    );
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('"file_id":"F999"');
    expect(out).toContain('"permalink":"https://overflow.slack.com/files/F999"');
  });

  it('uses --title when provided', async () => {
    mockClient.files.getUploadURLExternal.mockResolvedValue({
      ok: true,
      upload_url: 'https://files.slack.com/upload/v1/T',
      file_id: 'F1',
    });
    fetchSpy.mockResolvedValue({ ok: true, status: 200 } as Response);
    mockClient.files.completeUploadExternal.mockResolvedValue({ ok: true, files: [{ id: 'F1' }] });

    const { cmdSnippet } = await import('../../src/write/snippet.js');
    await cmdSnippet({ channel: 'C1', file: tmpFile, title: 'Custom Title' });

    expect(mockClient.files.completeUploadExternal).toHaveBeenCalledWith(
      expect.objectContaining({ files: [{ id: 'F1', title: 'Custom Title' }] }),
    );
  });

  it('throws User exit code when --file does not exist', async () => {
    const { cmdSnippet } = await import('../../src/write/snippet.js');
    await expect(
      cmdSnippet({ channel: 'C1', file: path.join(tmpHome, 'missing.md') }),
    ).rejects.toMatchObject({ name: 'SlackCliError', exitCode: 1 });
  });

  it('throws User exit code when --file is empty', async () => {
    const empty = path.join(tmpHome, 'empty.md');
    fs.writeFileSync(empty, '');
    const { cmdSnippet } = await import('../../src/write/snippet.js');
    await expect(
      cmdSnippet({ channel: 'C1', file: empty }),
    ).rejects.toMatchObject({ name: 'SlackCliError', exitCode: 1 });
  });

  it('throws Internal when getUploadURLExternal returns no upload_url', async () => {
    mockClient.files.getUploadURLExternal.mockResolvedValue({
      ok: false,
      error: 'invalid_auth',
    });
    const { cmdSnippet } = await import('../../src/write/snippet.js');
    await expect(
      cmdSnippet({ channel: 'C1', file: tmpFile }),
    ).rejects.toMatchObject({ name: 'SlackCliError', exitCode: 4 });
  });

  it('throws Internal when upload POST returns non-2xx', async () => {
    mockClient.files.getUploadURLExternal.mockResolvedValue({
      ok: true,
      upload_url: 'https://files.slack.com/upload/v1/X',
      file_id: 'F2',
    });
    fetchSpy.mockResolvedValue({ ok: false, status: 403 } as Response);
    const { cmdSnippet } = await import('../../src/write/snippet.js');
    await expect(
      cmdSnippet({ channel: 'C1', file: tmpFile }),
    ).rejects.toMatchObject({
      name: 'SlackCliError',
      exitCode: 4,
      message: expect.stringMatching(/upload POST failed with status 403/),
    });
  });

  it('throws User exit code when completeUploadExternal returns channel_not_found', async () => {
    mockClient.files.getUploadURLExternal.mockResolvedValue({
      ok: true,
      upload_url: 'https://files.slack.com/upload/v1/Y',
      file_id: 'F3',
    });
    fetchSpy.mockResolvedValue({ ok: true, status: 200 } as Response);
    mockClient.files.completeUploadExternal.mockResolvedValue({
      ok: false,
      error: 'channel_not_found',
    });
    const { cmdSnippet } = await import('../../src/write/snippet.js');
    await expect(
      cmdSnippet({ channel: 'C1', file: tmpFile }),
    ).rejects.toMatchObject({ name: 'SlackCliError', exitCode: 1 });
  });
});
