/**
 * Save a long Claude result as a self-contained HTML file under ~/Downloads,
 * so Slack messages can link to it via the open_html button (handled by this
 * bot — only existing .html files under ~/Downloads are allowed to open).
 */
import fs from "fs";
import os from "os";
import path from "path";
import { config } from "./config";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Minimal Markdown → HTML for readable rendering (headings, bold, links, lists, code, tables as pre). */
function markdownToHtml(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inCode = false;
  let inList = false;
  let inTable = false;

  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  const closeTable = () => {
    if (inTable) {
      out.push("</pre>");
      inTable = false;
    }
  };

  const inline = (s: string): string =>
    escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      // single-asterisk bold (Slack mrkdwn style, common in skill output)
      .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[、。,.:：)])/g, "$1<strong>$2</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>');

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");

    if (/^```/.test(line.trim())) {
      closeList();
      closeTable();
      if (inCode) {
        out.push("</pre>");
        inCode = false;
      } else {
        out.push("<pre>");
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      out.push(escapeHtml(line));
      continue;
    }

    const trimmed = line.trim();

    // Markdown table rows → monospace block (keeps alignment without a table parser)
    if (/^\|.*\|$/.test(trimmed)) {
      closeList();
      if (!inTable) {
        out.push('<pre class="table">');
        inTable = true;
      }
      out.push(escapeHtml(trimmed));
      continue;
    }
    closeTable();

    if (/^-{3,}$/.test(trimmed) || /^={3,}$/.test(trimmed)) {
      closeList();
      out.push("<hr>");
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length + 1, 4); // # → h2, ## → h3 …
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = trimmed.match(/^(?:[-•・]|\d+[.)])\s+(.+)$/);
    if (bullet) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }

    closeList();
    if (trimmed === "") {
      out.push("");
    } else {
      out.push(`<p>${inline(trimmed)}</p>`);
    }
  }
  closeList();
  closeTable();
  if (inCode) out.push("</pre>");
  return out.join("\n");
}

/**
 * Write the HTML file and return its absolute path.
 * Filename: claude-slack-YYYYMMDD-HHmmss.html (always under ~/Downloads).
 */
export function saveHtmlArtifact(title: string, markdown: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const filePath = path.join(os.homedir(), "Downloads", `claude-slack-${stamp}.html`);

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: "Hiragino Sans", "Noto Sans JP", sans-serif; line-height: 1.8;
         max-width: 780px; margin: 40px auto; padding: 0 24px; color: #1f2328; }
  h1 { font-size: 22px; border-bottom: 2px solid #e3e6ea; padding-bottom: 10px; }
  h2 { font-size: 19px; margin-top: 2em; border-bottom: 1px solid #e3e6ea; padding-bottom: 6px; }
  h3 { font-size: 17px; margin-top: 1.6em; }
  h4 { font-size: 15px; margin-top: 1.4em; }
  p { margin: 0.5em 0; }
  ul { padding-left: 1.4em; margin: 0.5em 0; }
  li { margin: 0.25em 0; }
  code { background: #f0f2f5; border-radius: 4px; padding: 1px 5px; font-size: 0.92em; }
  pre { background: #f6f8fa; border: 1px solid #e3e6ea; border-radius: 8px;
        padding: 14px; overflow-x: auto; font-size: 13px; line-height: 1.6; }
  hr { border: none; border-top: 1px solid #e3e6ea; margin: 1.6em 0; }
  a { color: #0b62c4; }
  .meta { color: #6b7280; font-size: 13px; margin-bottom: 28px; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<div class="meta">${escapeHtml(config.BOT_NAME)} (Slack Bot) — ${d.toLocaleString("ja-JP")}</div>
${markdownToHtml(markdown)}
</body>
</html>
`;
  fs.writeFileSync(filePath, html, "utf8");
  return filePath;
}
