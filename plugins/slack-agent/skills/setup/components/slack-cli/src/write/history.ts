import { makeWebClient } from '../common/client.js';
import { ExitCode, SlackCliError } from '../common/errors.js';
import { withRetry } from '../common/rate-limit.js';
import { verifyTokenKind } from '../common/token.js';

export interface HistoryOptions {
  channel: string;
  limit?: string;
  oldest?: string;
  latest?: string;
}

export async function cmdHistory(opts: HistoryOptions): Promise<void> {
  const limit = opts.limit !== undefined ? Number.parseInt(opts.limit, 10) : 20;
  if (!Number.isFinite(limit) || limit < 1 || limit > 1000) {
    throw new SlackCliError(
      `history: --limit must be an integer between 1 and 1000 (got: ${opts.limit})`,
      ExitCode.User,
    );
  }

  const client = makeWebClient('bot');
  await verifyTokenKind(client, 'bot');

  const args: Record<string, unknown> = {
    channel: opts.channel,
    limit,
  };
  if (opts.oldest) args['oldest'] = opts.oldest;
  if (opts.latest) args['latest'] = opts.latest;

  const res = await withRetry(() => client.conversations.history(args as any));

  process.stdout.write(
    JSON.stringify({
      ok: true,
      channel: opts.channel,
      message_count: res.messages?.length ?? 0,
      has_more: res.has_more ?? false,
      response_metadata: res.response_metadata,
      messages: res.messages ?? [],
    }) + '\n',
  );
}
