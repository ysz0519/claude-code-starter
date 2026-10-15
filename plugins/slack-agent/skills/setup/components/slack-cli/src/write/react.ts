import { makeWebClient } from '../common/client.js';
import { ExitCode, SlackCliError } from '../common/errors.js';
import { withRetry } from '../common/rate-limit.js';
import { verifyTokenKind } from '../common/token.js';

export interface ReactOptions {
  channel: string;
  timestamp: string;
  emoji: string;
}

export async function cmdReact(opts: ReactOptions): Promise<void> {
  const name = opts.emoji.replace(/^:|:$/g, '');
  if (!name) {
    throw new SlackCliError(
      'react: --emoji must be a non-empty emoji name (without colons)',
      ExitCode.User,
    );
  }

  const client = makeWebClient('bot');
  await verifyTokenKind(client, 'bot');

  await withRetry(() =>
    client.reactions.add({
      channel: opts.channel,
      timestamp: opts.timestamp,
      name,
    }),
  );

  process.stdout.write(
    JSON.stringify({
      ok: true,
      channel: opts.channel,
      timestamp: opts.timestamp,
      name,
    }) + '\n',
  );
}
