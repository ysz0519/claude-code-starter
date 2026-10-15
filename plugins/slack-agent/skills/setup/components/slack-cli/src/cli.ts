#!/usr/bin/env node
import './common/agent-config.js'; // 副作用: ~/.claude/.env.claude-slack-agent を process.env へ流し込む（他の import より先）
import { Command } from 'commander';
import { ExitCode, SlackCliError } from './common/errors.js';
import { error as logError } from './common/logger.js';

const BOT_HANDLE = (process.env.SLACK_BOT_HANDLE ?? 'claude_bot').trim();
const BOT_NOTE = `\nNOTE: Bot Token mode cannot access private channels or DMs where the bot is not a member.\n      Add the bot to the channel first with /invite @${BOT_HANDLE}.`;

const UNREAD_NOTE = `\nNOTE: 'unread' is an approximation using search.messages with is:unread filter.\n      It reflects Slack's search index, not the exact unread cursor state.\n      Results may differ from the Slack UI unread view.`;

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('slack-cli')
    .description('Slack CLI for Yuto Suzuki (Bot + User Token).')
    .version('1.0.0');

  program
    .command('send')
    .description('Send a Block Kit JSON or plain text message (Bot Token).' + BOT_NOTE)
    .requiredOption('--channel <ID>', 'Channel ID (required)')
    .option('--json-file <PATH>', 'Block Kit JSON file path')
    .option('--text <TEXT>', 'Plain text message')
    .option('--keep', 'Do not delete --json-file after send')
    .action(async (opts) => {
      const { cmdSend } = await import('./write/send.js');
      await cmdSend(opts);
    });

  program
    .command('react')
    .description('Add a reaction emoji to a message (Bot Token).' + BOT_NOTE)
    .requiredOption('--channel <ID>', 'Channel ID (required)')
    .requiredOption('--timestamp <TS>', 'Message timestamp (required)')
    .requiredOption('--emoji <NAME>', 'Emoji name without colons (required)')
    .action(async (opts) => {
      const { cmdReact } = await import('./write/react.js');
      await cmdReact(opts);
    });

  program
    .command('snippet')
    .description('Upload a file as a snippet via 3-stage API (Bot Token).' + BOT_NOTE)
    .requiredOption('--channel <ID>', 'Channel ID (required)')
    .requiredOption('--file <PATH>', 'File path to upload (required)')
    .option('--title <TITLE>', 'Snippet title')
    .option('--comment <TEXT>', 'Initial comment')
    .option('--filetype <TYPE>', 'Slack filetype hint (e.g. markdown, python)')
    .action(async (opts) => {
      const { cmdSnippet } = await import('./write/snippet.js');
      await cmdSnippet(opts);
    });

  program
    .command('history')
    .description('Fetch channel history (Bot Token).' + BOT_NOTE)
    .requiredOption('--channel <ID>', 'Channel ID (required)')
    .option('--limit <N>', 'Number of messages to fetch', '20')
    .option('--oldest <TS>', 'Only messages after this timestamp')
    .option('--latest <TS>', 'Only messages before this timestamp')
    .action(async (opts) => {
      const { cmdHistory } = await import('./write/history.js');
      await cmdHistory(opts);
    });

  program
    .command('search')
    .description('Search messages with a query (User Token).')
    .requiredOption('--query <TEXT>', 'Search query (required)')
    .option('--count <N>', 'Number of results', '20')
    .option('--sort <date|score>', 'Sort order', 'date')
    .action(async (opts) => {
      const { cmdSearch } = await import('./read/search.js');
      await cmdSearch(opts);
    });

  program
    .command('unread')
    .description('Fetch unread message approximation (User Token).' + UNREAD_NOTE)
    .option('--count <N>', 'Number of results', '20')
    .option('--channel <ID>', 'Limit to a specific channel')
    .action(async (opts) => {
      const { cmdUnread } = await import('./read/unread.js');
      await cmdUnread(opts);
    });

  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  if (err instanceof SlackCliError) {
    logError(err.message, { exitCode: err.exitCode });
    process.exit(err.exitCode);
  }
  const msg = err instanceof Error ? err.message : String(err);
  logError(`Unhandled error: ${msg}`);
  process.exit(ExitCode.Internal);
});
