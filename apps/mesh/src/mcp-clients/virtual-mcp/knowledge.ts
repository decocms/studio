/**
 * buildKnowledgeBlock — renders an agent's attached files and skills into a
 * `<knowledge>` block that is appended to the agent's served instructions.
 *
 * It lives in the served instructions (not a cluster-only prompt block) so it
 * reaches the model on EVERY run path — the in-process cluster engine and the
 * sandbox/desktop daemon both read the agent's instructions, but only the
 * cluster engine runs the richer `buildAgentSystemPrompt`. Keeping it here is
 * the single source that covers both.
 *
 * Awareness-first: the agent is told the complete set of attached items with
 * the exact sandbox path to read each one. Files are mounted into the agent's
 * org filesystem, so it can open them directly with its file tools (works for
 * text and binary alike) — no inlining needed.
 */

import type { KnowledgeFile } from "@/tools/virtual/schema";
import { orgFsSandboxPath } from "@/file-storage/mount/provisioning";

function describe(file: KnowledgeFile): string {
  const parts = [file.contentType ?? "file"];
  if (file.size != null) parts.push(`${file.size} bytes`);
  return parts.join(", ");
}

/**
 * Build the `<knowledge>` block for an agent's attached files/skills, or
 * `null` when there are none. Pure and synchronous so it can be folded into
 * `getInstructions()` on the passthrough client and the virtual-MCP endpoint.
 */
function buildKnowledgeBlock(
  knowledge: KnowledgeFile[] | null | undefined,
  orgSlug: string,
): string | null {
  if (!knowledge || knowledge.length === 0) return null;

  const docs = knowledge.filter((f) => f.kind !== "skill");
  const skills = knowledge.filter((f) => f.kind === "skill");

  const docInventory = docs
    .map(
      (f) =>
        `- ${f.name} (${describe(f)}), read it at \`${orgFsSandboxPath(f.volume, f.path, orgSlug)}\``,
    )
    .join("\n");
  const skillInventory = skills
    .map(
      (s) =>
        `- ${s.name}: a skill at \`${orgFsSandboxPath(s.volume, s.path, orgSlug)}\`; read its \`SKILL.md\` before applying it`,
    )
    .join("\n");

  const lines = [
    "<knowledge>",
    "The following files and skills are attached to you as reference knowledge. They are mounted in your sandbox at the paths below; read them with your file tools when relevant to the task, and treat them as authoritative reference material.",
  ];
  if (docInventory) lines.push("", "Attached files:", docInventory);
  if (skillInventory) lines.push("", "Attached skills:", skillInventory);
  lines.push("</knowledge>");
  return lines.join("\n");
}

/** Append the knowledge block to an agent's instructions, if it has any. */
export function withKnowledge(
  instructions: string | undefined,
  knowledge: KnowledgeFile[] | null | undefined,
  orgSlug: string,
): string | undefined {
  const block = buildKnowledgeBlock(knowledge, orgSlug);
  if (!block) return instructions;
  return instructions ? `${instructions}\n\n${block}` : block;
}
