import { runClaude } from "./claude";
import type { SourceType } from "./approval";

interface GenerateReplyParams {
  sourceType: SourceType;
  senderName: string;
  /** Conversation context (older messages first) */
  context: string[];
  /** The new message to reply to */
  newMessage: string;
  /** Extra metadata (channel name, email subject, etc.) */
  metadata?: string;
}

/**
 * Generate 3 reply pattern drafts using Claude CLI.
 * Returns an array of 3 different reply texts with the same tone but different content.
 */
export async function generateReply(params: GenerateReplyParams): Promise<string[]> {
  const sourceLabel = params.sourceType === "slack" ? "Slack" : "メール";

  const contextBlock = params.context.length > 0
    ? `\n## 直前の会話:\n${params.context.map((m, i) => `${i + 1}. ${m}`).join("\n")}\n`
    : "";

  const metadataBlock = params.metadata ? `\n## 補足情報:\n${params.metadata}\n` : "";

  const prompt = `あなたはビジネスアシスタントです。以下の${sourceLabel}メッセージに対する返信案を**3パターン**生成してください。

## ルール:
- 各パターンは内容やアプローチを変える（同じトーンでOK）
- パターン1: 簡潔・ストレートな返信
- パターン2: 少し丁寧・補足情報を加えた返信
- パターン3: 別の切り口や提案を含む返信
- 返信テキストのみを出力する（前置きや説明は不要）
- 相手の名前や敬称は文脈に合わせる
- ${params.sourceType === "slack" ? "カジュアルなトーンでOK（社内Slack）" : "ビジネスメールとして適切な丁寧さ"}
- 日本語で返信する（相手が英語の場合は英語で返信）
- 必ず以下のフォーマットで出力すること:

---1---
(パターン1の返信テキスト)
---2---
(パターン2の返信テキスト)
---3---
(パターン3の返信テキスト)
${metadataBlock}${contextBlock}
## 新着メッセージ（${params.senderName}さんから）:
${params.newMessage}

## 返信案:`;

  const { result } = await runClaude(prompt, { maxTurns: 1 });

  // If Claude returned an error/fallback message, throw so caller can handle
  if (result.startsWith("⚠️") || result === "(empty)") {
    throw new Error(`Claude returned no usable reply: ${result}`);
  }

  // Parse 3 patterns from the result
  const patterns = result.split(/---[123]---/).filter((s) => s.trim());

  // Ensure we always have exactly 3 patterns
  const cleaned = patterns.slice(0, 3).map((p) =>
    p.replace(/^["「『]|["」』]$/g, "").trim()
  );

  // Fallback: if parsing failed, use the whole result as pattern 1
  while (cleaned.length < 3) {
    cleaned.push(cleaned[0] ?? result.trim());
  }

  return cleaned;
}
