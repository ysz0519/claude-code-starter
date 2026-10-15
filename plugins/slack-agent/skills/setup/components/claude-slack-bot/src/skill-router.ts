import { existsSync } from "fs";
import { join } from "path";
import { config } from "./config";
import { getSkillCatalog } from "./system-prompt";

export interface SkillMatch {
  skillName: string;
  budget: number;
}

/**
 * Keyword-to-skill mapping.
 * Each entry: [regex pattern, skill name, budget tier]
 */
const SKILL_PATTERNS: Array<[RegExp, string, number]> = [
  // Facebook Messenger URL を貼ったら返信案を作る（messenger-reply・read-only 取得 → 返信案テキスト）
  // 先頭に置き、URL 検知を他の keyword パターンより優先する
  [
    /https?:\/\/(?:www\.)?(?:messenger\.com\/(?:e2ee\/)?t\/|facebook\.com\/messages\/(?:e2ee\/)?t\/)\S+/i,
    "messenger-reply",
    config.BUDGET_SKILL,
  ],

  // Agent Teams は全廃（2026-08-26 鈴木指示）。後継は management-agent-team / ad-lead-review /
  // hiring-lead / pm-lead の各統括機構。skill 実体を削除したためルーティングを撤去した
  // （旧: [/戦略チーム|strategy.?team|agent.?team|チームで|チーム起動/i, "strategy-team", config.BUDGET_TEAM]）
  // board-team は 2026-08-23 に凍結（機構停止・鈴木指示）。ルーティングを撤去した
  // （旧: [/ボード|board|CxO|cfo|cto|coo|chro/i, "board-team", config.BUDGET_TEAM]）

  // 2026-08-26: 実在しないスキルへのルーティング 3 件（blog-writer / offers-pptx / offers-bigquery-analysis）を削除。
  // 以後、ルーティング先は skillExists() で `.claude/skills/<name>/SKILL.md` の実在を検証する（実在しなければ汎用処理へ）

  // Content creation skills
  [/x投稿|xの下書き|ツイート|twitter.*下書き/i, "x-daily-post", config.BUDGET_SKILL],
  [/日報/i, "daily-report", config.BUDGET_SKILL],
  [/seo記事|seo.*書/i, "seo-article-writer", config.BUDGET_SKILL],
  [/ホワイトペーパー|whitepaper|wp.*作成/i, "whitepaper-writer", config.BUDGET_SKILL],

  // Analysis & reports
  [/seo.*データ|gsc.*データ/i, "seo-data-collector", config.BUDGET_SKILL],
  [/seo.*リライト|リライト判定/i, "seo-rewriter", config.BUDGET_SKILL],
  [/seo.*戦略|seo.*strategy/i, "seo-strategy", config.BUDGET_SKILL],
  [/seo.*月次|seo.*レポート/i, "seo-monthly-report", config.BUDGET_SKILL],
  [/x.*週次.*レポート|x.*weekly/i, "x-weekly-kpi-report", config.BUDGET_SKILL],
  [/x.*月次.*レポート|x.*monthly/i, "x-monthly-kpi-report", config.BUDGET_SKILL],
  [/月次.*plcf|plcf.*レポート|pl.*cf.*レポート/i, "monthly-plcf-report", config.BUDGET_SKILL],
  [/月報|月次振り返り/i, "monthly-review", config.BUDGET_SKILL],

  // Operational skills
  [/メール.*todo|朝.*メール|未返信/i, "morning-email-todo", config.BUDGET_SKILL],
  [/メール.*下書き|返信.*ドラフト/i, "email-draft", config.BUDGET_SKILL],
  [/議事録.*タスク|mtg.*タスク|会議.*タスク抽出/i, "meeting-task-extract", config.BUDGET_SKILL],
  [/tldv|録画.*データ|会議.*録画/i, "tldv-meeting-lookup", config.BUDGET_SKILL],
  [/ソーシャルリスニング|x.*検索.*分析/i, "x-social-listening", config.BUDGET_SKILL],
  [/週次.*戦略.*提案|戦略提言/i, "weekly-strategy-proposal", config.BUDGET_SKILL],
  [/空き.*スロット|日程.*候補|空き時間/i, "calendar-available-slots", config.BUDGET_SKILL],
];

/**
 * Detect if a message should trigger a specific skill.
 * Returns the skill name and appropriate budget, or null for general handling.
 */
/**
 * ルーティング先スキルの実在検証（2026-08-26）。
 * skill catalog（system-prompt.ts が SKILL.md の frontmatter から起動時に構築）に載っているか、
 * または `.claude/skills/<name>/SKILL.md` が存在するか。どちらも無ければ実在しないとみなす。
 * （catalog は name/description の無い SKILL.md を含まないため、ファイル実在でも補う）
 */
export function skillExists(name: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) return false;
  if (getSkillCatalog().some((s) => s.name === name)) return true;
  try {
    return existsSync(join(config.SKILLS_DIR, name, "SKILL.md"));
  } catch {
    return false;
  }
}

export function detectSkill(message: string): SkillMatch | null {
  // Explicit skill invocation: "/skill-name" or "skill-name スキル"
  const explicitMatch = message.match(/^\/(\S+)/);
  if (explicitMatch) {
    const name = explicitMatch[1];
    // 実在しないスキル名は汎用処理へ（存在しない /name で claude を起動しない）
    if (!skillExists(name)) {
      console.warn(`[skill-router] Unknown skill "/${name}" — falling back to general handling`);
      return null;
    }
    const isTeam = name.includes("team");
    return {
      skillName: name,
      budget: isTeam ? config.BUDGET_TEAM : config.BUDGET_SKILL,
    };
  }

  // Pattern matching
  for (const [pattern, skillName, budget] of SKILL_PATTERNS) {
    if (pattern.test(message)) {
      if (!skillExists(skillName)) {
        console.warn(`[skill-router] Routed skill "${skillName}" does not exist — falling back to general handling`);
        continue;
      }
      return { skillName, budget };
    }
  }

  return null;
}

/**
 * Build the prompt with skill directive prepended.
 */
export function buildSkillPrompt(userMessage: string, skillName: string): string {
  return `/${skillName} スキルに従って実行してください。\n\nユーザーの指示: ${userMessage}`;
}
