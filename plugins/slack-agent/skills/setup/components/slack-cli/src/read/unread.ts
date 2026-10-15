import { makeWebClient } from '../common/client.js';
import { ExitCode, SlackCliError } from '../common/errors.js';
import { withRetry } from '../common/rate-limit.js';
import { verifyTokenKind } from '../common/token.js';

export interface UnreadOptions {
  count?: string;
  channel?: string;
}

interface SearchResponse {
  ok?: boolean;
  error?: string;
  messages?: {
    total?: number;
    matches?: unknown[];
  };
}

export async function cmdUnread(opts: UnreadOptions): Promise<void> {
  const count = opts.count !== undefined ? Number.parseInt(opts.count, 10) : 20;
  if (!Number.isFinite(count) || count < 1 || count > 100) {
    throw new SlackCliError(
      `unread: --count must be an integer between 1 and 100 (got: ${opts.count})`,
      ExitCode.User,
    );
  }

  const query = ['is:unread']
    .concat(opts.channel ? [`in:${opts.channel}`] : [])
    .join(' ');

  const client = makeWebClient('user');
  await verifyTokenKind(client, 'user');

  const res = (await withRetry(() =>
    client.search.messages({
      query,
      count,
      sort: 'date',
      sort_dir: 'desc',
    } as any),
  )) as SearchResponse;

  if (!res.ok) {
    const msg = res.error ?? 'unknown';
    const code = msg === 'missing_scope' || msg === 'not_allowed_token_type'
      ? ExitCode.Auth
      : ExitCode.Internal;
    throw new SlackCliError(`unread (search.messages) failed: ${msg}`, code);
  }

  const matches = res.messages?.matches ?? [];
  process.stdout.write(
    JSON.stringify({
      ok: true,
      query,
      total: res.messages?.total ?? matches.length,
      match_count: matches.length,
      matches,
      note: 'unread is an approximation via search.messages is:unread; reflects Slack search index, not exact cursor state',
    }) + '\n',
  );
}
