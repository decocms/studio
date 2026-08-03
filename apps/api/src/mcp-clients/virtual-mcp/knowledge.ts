/**
 * buildKnowledgeBlock — renders an agent's attached reference FILES into a
 * `<knowledge>` block that is appended to the agent's served instructions.
 *
 * It lives in the served instructions (not a cluster-only prompt block) so it
 * reaches the model on every run path — hosted Decopilot and native
 * coding-agent terminals both read the served instructions, while only the
 * hosted engine runs the richer `buildAgentSystemPrompt`. Keeping it here is
 * the single source that covers both.
 *
 * Attached SKILLS are deliberately NOT listed here — they live in the single
 * `<available-skills>` catalog (skills-instructions.ts), where they're flagged
 * as user-configured. Keeping skill metadata in one place avoids the catalog
 * and this block drifting out of sync.
 *
 * Awareness-first: the agent is told the complete set of attached files with
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
 * Build the `<knowledge>` block for an agent's attached files, or `null` when
 * there are none. Pure and synchronous so it can be folded into
 * `getInstructions()` on the passthrough client and the virtual-MCP endpoint.
 */
function buildKnowledgeBlock(
  knowledge: KnowledgeFile[] | null | undefined,
): string | null {
  // Skills go in the <available-skills> catalog, not here.
  const docs = (knowledge ?? []).filter((f) => f.kind !== "skill");
  if (docs.length === 0) return null;

  const docInventory = docs
    .map(
      (f) =>
        `- ${f.name} (${describe(f)}), read it at \`${orgFsSandboxPath(f.volume, f.path)}\``,
    )
    .join("\n");

  return [
    "<knowledge>",
    "The following files are attached to you as reference knowledge. They are mounted in your sandbox at the paths below; read them with your file tools when relevant to the task, and treat them as authoritative reference material.",
    "",
    "Attached files:",
    docInventory,
    "</knowledge>",
  ].join("\n");
}

/** Append the knowledge block to an agent's instructions, if it has any. */
export function withKnowledge(
  instructions: string | undefined,
  knowledge: KnowledgeFile[] | null | undefined,
): string | undefined {
  const block = buildKnowledgeBlock(knowledge);
  if (!block) return instructions;
  return instructions ? `${instructions}\n\n${block}` : block;
}
