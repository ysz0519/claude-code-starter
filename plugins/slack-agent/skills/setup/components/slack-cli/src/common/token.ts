import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { WebClient } from '@slack/web-api';
import { ExitCode, SlackCliError } from './errors.js';

export type TokenKind = 'bot' | 'user';

function home(): string {
  return process.env['HOME'] ?? os.homedir();
}

const TOKEN_FILENAMES: Record<TokenKind, string> = {
  bot: '.env.slack-cli.bot',
  user: '.env.slack-cli.user',
};

const ENV_KEYS: Record<TokenKind, string> = {
  bot: 'SLACK_BOT_TOKEN',
  user: 'SLACK_USER_TOKEN',
};

export function tokenFilePath(kind: TokenKind): string {
  return path.join(home(), '.claude', TOKEN_FILENAMES[kind]);
}

export function parseTokenValue(raw: string): string {
  let value = raw.trim();
  // Strip inline comment ("# ..." after whitespace) only if value is not quoted.
  if (!/^["']/.test(value)) {
    const commentIdx = value.search(/\s+#/);
    if (commentIdx >= 0) {
      value = value.slice(0, commentIdx).trim();
    }
  }
  // Strip surrounding matching quotes (single or double).
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

export function resolveToken(kind: TokenKind): string {
  const file = tokenFilePath(kind);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err: any) {
    throw new SlackCliError(
      `Token file not found or unreadable: ${file} (${err?.code ?? err?.message ?? 'unknown'})`,
      ExitCode.Auth,
    );
  }
  const key = ENV_KEYS[kind];
  const match = raw.match(new RegExp(`^${key}=(.+)$`, 'm'));
  if (!match || !match[1]) {
    throw new SlackCliError(`${key} not found in ${file}`, ExitCode.Auth);
  }
  const value = parseTokenValue(match[1]);
  if (!value) {
    throw new SlackCliError(`${key} has empty value in ${file}`, ExitCode.Auth);
  }
  return value;
}

export async function verifyTokenKind(
  client: WebClient,
  expected: TokenKind,
): Promise<void> {
  let res: any;
  try {
    res = await client.auth.test();
  } catch (err: any) {
    const msg = err?.data?.error ?? err?.message ?? 'unknown';
    throw new SlackCliError(`auth.test failed: ${msg}`, ExitCode.Auth);
  }
  const isBot = !!res?.bot_id;
  if (expected === 'bot' && !isBot) {
    throw new SlackCliError('Expected Bot Token but got User Token', ExitCode.Auth);
  }
  if (expected === 'user' && isBot) {
    throw new SlackCliError('Expected User Token but got Bot Token', ExitCode.Auth);
  }
}
