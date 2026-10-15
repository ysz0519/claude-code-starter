import { makeWebClient } from '../common/client.js';
import { ExitCode, SlackCliError } from '../common/errors.js';
import { withRetry } from '../common/rate-limit.js';
import { verifyTokenKind } from '../common/token.js';

export interface SearchOptions {
  query: string;
  count?: string;
  sort?: string;
}

interface SearchResponse {
  ok?: boolean;
  error?: string;
  query?: string;
  messages?: {
    total?: number;
    pagination?: unknown;
    matches?: unknown[];
  };
}

export async function cmdSearch(opts: SearchOptions): Promise<void> {
  if (!opts.query.trim()) {
    throw new SlackCliError(
      'search: --query must not be empty',
      ExitCode.User,
    );
  }
  const count = opts.count !== undefined ? Number.parseInt(opts.count, 10) : 20;
  if (!Number.isFinite(count) || count < 1 || count > 100) {
    throw new SlackCliError(
      `search: --count must be an integer between 1 and 100 (got: ${opts.count})`,
      ExitCode.User,
    );
  }
  const sort = opts.sort ?? 'date';
  if (sort !== 'date' && sort !== 'score') {
    throw new SlackCliError(
      `search: --sort must be 'date' or 'score' (got: ${sort})`,
      ExitCode.User,
    );
  }

  const client = makeWebClient('user');
  await verifyTokenKind(client, 'user');

  const res = (await withRetry(() =>
    client.search.messages({
      query: opts.query,
      count,
      sort,
      sort_dir: 'desc',
    } as any),
  )) as SearchResponse;

  if (!res.ok) {
    const msg = res.error ?? 'unknown';
    const code = msg === 'missing_scope' || msg === 'not_allowed_token_type'
      ? ExitCode.Auth
      : ExitCode.Internal;
    throw new SlackCliError(`search.messages failed: ${msg}`, code);
  }

  const matches = res.messages?.matches ?? [];
  process.stdout.write(
    JSON.stringify({
      ok: true,
      query: opts.query,
      total: res.messages?.total ?? matches.length,
      match_count: matches.length,
      matches,
    }) + '\n',
  );
}
