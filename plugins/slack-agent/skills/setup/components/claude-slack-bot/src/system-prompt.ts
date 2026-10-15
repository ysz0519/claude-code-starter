import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { config } from "./config";

interface SkillEntry {
  name: string;
  description: string;
}

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Extracts `name` and `description` fields.
 */
function parseSkillFrontmatter(content: string): SkillEntry | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  const nameMatch = yaml.match(/^name:\s*(.+)$/m);
  const descMatch = yaml.match(/^description:\s*(.+)$/m);

  if (!nameMatch || !descMatch) return null;

  return {
    name: nameMatch[1].trim(),
    description: descMatch[1].trim(),
  };
}

/**
 * Scan all SKILL.md files and build skill catalog.
 */
function loadSkillCatalog(): SkillEntry[] {
  const skills: SkillEntry[] = [];
  try {
    const dirs = readdirSync(config.SKILLS_DIR, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const skillPath = join(config.SKILLS_DIR, dir.name, "SKILL.md");
      try {
        const content = readFileSync(skillPath, "utf-8");
        const entry = parseSkillFrontmatter(content);
        if (entry) skills.push(entry);
      } catch {
        // SKILL.md doesn't exist or can't be read — skip
      }
    }
  } catch {
    console.warn("[system-prompt] Failed to read skills directory");
  }
  return skills;
}

// Cache the skill catalog at module load time
const skillCatalog = loadSkillCatalog();
console.log(`[system-prompt] Loaded ${skillCatalog.length} skills`);

/** Exported for skill-router to use */
export function getSkillCatalog(): SkillEntry[] {
  return skillCatalog;
}

/**
 * Build the system prompt that establishes the AI Employee persona.
 * This gets prepended to every user message sent to Claude CLI.
 */
export function buildSystemPrompt(): string {
  const today = new Date().toISOString().split("T")[0];

  const skillList = skillCatalog
    .map((s) => `- /${s.name}: ${s.description}`)
    .join("\n");

  return `あなたは ${config.BOT_NAME}（AI社員）です。Slack DMで ${config.OWNER_NAME} からの指示を受け、自律的に実行します。

## 基本ルール
- 結論ファーストで回答する
- 日本語で回答する（データソースが英語の場合は原文引用可）
- ファイル操作は ${config.DEFAULT_CWD} 配下で行う
- 今日の日付: ${today}

## Slack書式ルール（重要）
SlackはMarkdownではなく独自のmrkdwn記法を使う。以下を厳守すること：
- 太字: *テキスト*（アスタリスク1つ。**ではない）
- 斜体: _テキスト_
- 取り消し線: ~テキスト~
- コード: \`テキスト\`
- コードブロック: \`\`\`テキスト\`\`\`
- 見出し（#）は使えない → *太字* で代替する
- テーブル（表）は使えない → 箇条書きで代替する
- 区切り線として空行を活用して視認性を高める
- 数値や重要指標は *太字* で強調する
- セクション間に空行を入れて読みやすくする

## 利用可能なスキル
以下のスキルは /skill-name で呼び出せます。ユーザーの意図に合うスキルがあれば、そのスキルの指示に従って実行してください。

${skillList}

## スキル以外の対応
スキルに該当しない依頼（日程調整、調べ物、壁打ち、分析など）は、利用可能なMCPツール（Google Calendar、Gmail、Slack、HubSpot、Salesforce、WebSearch等）を駆使して直接対応してください。

`;
}
