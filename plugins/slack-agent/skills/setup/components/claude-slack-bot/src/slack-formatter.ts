/**
 * Convert standard Markdown to Slack mrkdwn format,
 * then build Block Kit blocks for rich display.
 */

interface SlackBlock {
  type: string;
  text?: { type: string; text: string; emoji?: boolean };
  elements?: Array<{ type: string; text: string }>;
}

/**
 * Convert Markdown → Slack mrkdwn text.
 * - **bold** → *bold*
 * - ### heading → *heading*
 * - [text](url) → <url|text>
 */
export function toSlackMrkdwn(text: string): string {
  return (
    text
      // Bold: **text** → *text* (must come before single * handling)
      .replace(/\*\*(.+?)\*\*/g, "*$1*")
      // Headers: ### text or ## text or # text → *text* (on its own line)
      .replace(/^#{1,3}\s+(.+)$/gm, "*$1*")
      // Links: [text](url) → <url|text>
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>")
  );
}

/**
 * Split mrkdwn text into Slack Block Kit blocks.
 * Uses `header` for lines that look like section titles,
 * `divider` for --- lines, and `section` for body text.
 *
 * Slack limits: max 50 blocks, section text max 3000 chars.
 */
export function toSlackBlocks(mrkdwnText: string): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  const lines = mrkdwnText.split("\n");

  let buffer = "";

  const flushBuffer = () => {
    const trimmed = buffer.trim();
    if (trimmed) {
      // Split into 3000-char chunks if needed
      for (let i = 0; i < trimmed.length; i += 3000) {
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: trimmed.slice(i, i + 3000) },
        });
      }
    }
    buffer = "";
  };

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Divider: --- or ===
    if (/^-{3,}$/.test(trimmedLine) || /^={3,}$/.test(trimmedLine)) {
      flushBuffer();
      blocks.push({ type: "divider" });
      continue;
    }

    // Header block: line that is *bold text* only (entire line)
    // and looks like a section title (short, no bullet prefix)
    if (
      /^\*[^*]+\*$/.test(trimmedLine) &&
      trimmedLine.length <= 150 &&
      !trimmedLine.startsWith("- ") &&
      !trimmedLine.startsWith("• ")
    ) {
      flushBuffer();
      // Use header block (max 150 chars, plain_text only)
      const headerText = trimmedLine.replace(/^\*|\*$/g, "");
      blocks.push({
        type: "header",
        text: { type: "plain_text", text: headerText, emoji: true },
      });
      continue;
    }

    // Normal line: accumulate into buffer
    buffer += line + "\n";
  }

  flushBuffer();

  // Slack max 50 blocks — truncate if needed
  if (blocks.length > 50) {
    blocks.length = 49;
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_(出力が長いため一部省略)_" },
    });
  }

  return blocks;
}

/**
 * Format Claude output for Slack: convert markdown and build blocks.
 * Returns { text, blocks } ready for chat.postMessage / chat.update.
 */
export function formatForSlack(rawText: string): {
  text: string;
  blocks: SlackBlock[];
} {
  const mrkdwn = toSlackMrkdwn(rawText);
  const blocks = toSlackBlocks(mrkdwn);
  // `text` is only the notification fallback when blocks are present.
  // Slack rejects the whole call with msg_too_long when it's too large,
  // so cap it well below the API limit.
  const fallback = mrkdwn.length > 2900 ? mrkdwn.slice(0, 2900) + "…" : mrkdwn;
  return { text: fallback, blocks };
}
