/**
 * Builds the <available-skills> system-prompt block — the progressive-
 * disclosure index of the org's installed skills (Claude Code style): every
 * skill's name + description is listed up front so the agent knows WHEN to
 * reach for one, but the body (SKILL.md) is loaded on demand via `read`.
 *
 * Returns null when there are no skills, so the block drops out entirely.
 */

import { csvField } from "./prompts-block";

export interface SkillEntry {
  /** Disambiguated id, `<set>/<skill>` (e.g. `core/pdf`). */
  name: string;
  description: string;
  /** Sandbox path to the SKILL.md, for the agent to `read`. */
  path: string;
}

const USAGE = `<skills-usage>
Each skill is a folder with a SKILL.md. The table above is the index — read a
skill's SKILL.md (via the read tool, at the listed path) BEFORE applying it,
and only when the task matches its description. Do not read skills you don't need.
</skills-usage>`;

/**
 * Parse the leading YAML frontmatter of a SKILL.md. Intentionally NOT a full
 * YAML parser — SKILL frontmatter is flat `key: value` lines, so a line scan
 * is enough. Returns {} when there's no frontmatter.
 * ponytail: flat key:value only; add a real YAML dep if skills ever need nesting.
 */
export function parseSkillFrontmatter(text: string): {
  name?: string;
  description?: string;
} {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  const out: Record<string, string> = {};
  for (const line of text.slice(3, end).split("\n")) {
    const [, key, val] = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim()) ?? [];
    if (key) out[key] = (val ?? "").replace(/^(["'])(.*)\1$/u, "$2");
  }
  return out;
}

export function buildSkillsBlock(skills: SkillEntry[]): string | null {
  if (skills.length === 0) return null;
  const rows = skills.map(
    (s) => `${csvField(s.name)},${csvField(s.description)},${csvField(s.path)}`,
  );
  return (
    `\n\n<available-skills>\nname,description,path\n${rows.join("\n")}\n</available-skills>` +
    `\n\n${USAGE}`
  );
}
