/**
 * Builds the <available-skills> + <skills-usage> system-prompt block — the
 * skill analogue of <available-prompts> (prompts-block.ts). Gives the agent
 * Claude-Code-style progressive discovery: every skill's id + description is
 * listed up front, and the full SKILL.md body is loaded on demand via the
 * `skill` tool.
 *
 * Returns null when the catalog is empty so the block — and the Skill-tool
 * guidance that depends on it — drops out of the prompt entirely.
 */

import { csvField } from "./csv";

export interface SkillsBlockEntry {
  /** Resolvable, collision-free id the `skill` tool takes (e.g. "core/slides"). */
  id: string;
  description: string | null;
  /** Provenance shown to the model (e.g. "public:core" or "home"). */
  source: string;
}

/** Keep descriptions compact so the catalog stays in the cached prefix. */
const MAX_DESCRIPTION = 200;
function truncate(s: string | null): string {
  if (!s) return "";
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_DESCRIPTION
    ? flat
    : `${flat.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…`;
}

const USAGE = `<skills-usage>
Each skill is a reusable capability with full instructions in its SKILL.md.
Load one with skill({ id }) BEFORE applying it, then follow its instructions
(run its scripts via bash).

WARNING: If a skill's SKILL.md already appears anywhere in the conversation
history, you MUST NOT call skill for it again — its instructions are already
loaded. Only call skill for a skill whose SKILL.md is NOT yet in the
conversation.
</skills-usage>`;

/**
 * @param configuredIds ids the user explicitly attached to this agent — called
 *   out so the model prefers them. They also appear as normal catalog rows.
 */
export function buildSkillsBlock(
  skills: SkillsBlockEntry[],
  configuredIds: string[] = [],
): string | null {
  if (skills.length === 0) return null;

  const rows = skills.map(
    (s) =>
      `${csvField(s.id)},${csvField(truncate(s.description))},${csvField(s.source)}`,
  );

  const present = new Set(skills.map((s) => s.id));
  const configured = configuredIds.filter((id) => present.has(id));
  const callout =
    configured.length > 0
      ? `\n\nThe user explicitly configured these skills for this agent — ` +
        `prefer them when the task is relevant: ${configured.join(", ")}.`
      : "";

  return (
    `\n\n<available-skills>\nid,description,source\n${rows.join("\n")}\n</available-skills>` +
    callout +
    `\n\n${USAGE}`
  );
}
