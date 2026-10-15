import fs from 'node:fs';
import path from 'node:path';
import { makeWebClient } from '../common/client.js';
import { ExitCode, SlackCliError } from '../common/errors.js';
import { withRetry } from '../common/rate-limit.js';
import { verifyTokenKind } from '../common/token.js';

export interface SnippetOptions {
  channel: string;
  file: string;
  title?: string;
  comment?: string;
  filetype?: string;
}

interface UploadUrlResponse {
  ok?: boolean;
  upload_url?: string;
  file_id?: string;
  error?: string;
}

interface CompleteUploadResponse {
  ok?: boolean;
  files?: Array<{ id?: string; name?: string; permalink?: string }>;
  error?: string;
}

const PUT_TIMEOUT_MS = 30_000;

export async function cmdSnippet(opts: SnippetOptions): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(opts.file);
  } catch (err: any) {
    throw new SlackCliError(
      `snippet: failed to stat --file: ${opts.file} (${err?.code ?? err?.message ?? 'unknown'})`,
      ExitCode.User,
    );
  }
  if (!stat.isFile()) {
    throw new SlackCliError(
      `snippet: --file is not a regular file: ${opts.file}`,
      ExitCode.User,
    );
  }
  if (stat.size === 0) {
    throw new SlackCliError(
      `snippet: --file is empty (0 bytes): ${opts.file}`,
      ExitCode.User,
    );
  }

  const filename = path.basename(opts.file);
  const title = opts.title ?? filename;

  const client = makeWebClient('bot');
  await verifyTokenKind(client, 'bot');

  const urlRes = (await withRetry(() =>
    client.files.getUploadURLExternal({
      filename,
      length: stat.size,
      ...(opts.filetype ? { filetype: opts.filetype } : {}),
    }),
  )) as UploadUrlResponse;

  if (!urlRes.ok || !urlRes.upload_url || !urlRes.file_id) {
    throw new SlackCliError(
      `snippet: files.getUploadURLExternal failed: ${urlRes.error ?? 'no upload_url returned'}`,
      ExitCode.Internal,
    );
  }

  const bodyBuf = fs.readFileSync(opts.file);
  const form = new FormData();
  form.append('filename', new Blob([bodyBuf]), filename);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUT_TIMEOUT_MS);
  let uploadRes: Response;
  try {
    uploadRes = await fetch(urlRes.upload_url, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
  } catch (err: any) {
    throw new SlackCliError(
      `snippet: upload POST failed: ${err?.message ?? 'unknown'}`,
      ExitCode.Internal,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!uploadRes.ok) {
    throw new SlackCliError(
      `snippet: upload POST failed with status ${uploadRes.status}`,
      ExitCode.Internal,
    );
  }

  const completeRes = (await withRetry(() =>
    client.files.completeUploadExternal({
      files: [{ id: urlRes.file_id!, title }],
      channel_id: opts.channel,
      ...(opts.comment ? { initial_comment: opts.comment } : {}),
    }),
  )) as CompleteUploadResponse;

  if (!completeRes.ok) {
    throw new SlackCliError(
      `snippet: files.completeUploadExternal failed: ${completeRes.error ?? 'unknown'}`,
      completeRes.error === 'channel_not_found' || completeRes.error === 'not_in_channel'
        ? ExitCode.User
        : ExitCode.Internal,
    );
  }

  const file = completeRes.files?.[0];
  process.stdout.write(
    JSON.stringify({
      ok: true,
      channel: opts.channel,
      file_id: file?.id ?? urlRes.file_id,
      name: file?.name ?? filename,
      permalink: file?.permalink,
    }) + '\n',
  );
}
