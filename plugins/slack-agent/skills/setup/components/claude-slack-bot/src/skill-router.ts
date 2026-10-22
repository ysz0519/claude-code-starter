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
  // 自分のスキルへの振り分けをここに足す（例: [/日報/i, "daily-report", config.BUDGET_SKILL]）。
  // ルーティング先は skillExists() で `.claude/skills/<name>/SKILL.md` の実在を検証する（実在しなければ汎用処理へ）
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
