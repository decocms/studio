/**
 * buildKnowledgeBlock — renders the agent's attached knowledge files into a
 * `<knowledge>` system-prompt block.
 *
 * Awareness-first: the agent is ALWAYS told the complete set of files attached
 * to it (name, type, size), so it knows what reference material it has. On top
 * of that inventory, the contents of small text documents are inlined in full
 * (within a budget) so the agent can use them directly without a retrieval
 * round-trip. Larger or binary files appear in the inventory but are not
 * inlined.
 *
 * Knowledge is read from storage here (rather than threaded through the run
 * pipeline) because the wire `virtualMcp` ref is narrowed to `{ id, repo }`
 * upstream; `ctx` is the cleanest place to resolve the full metadata.
 */

import type { StudioContext, OrganizationScope } from "@/core/studio-context";
import type { KnowledgeFile } from "@/tools/virtual/schema";
import { orgFsSandboxPath } from "@/file-storage/mount/provisioning";

/** Inline at most this many characters from a single file. */
const INLINE_PER_FILE_CHARS = 32 * 1024;
/** Inline at most this many characters across all files combined. */
const INLINE_TOTAL_CHARS = 128 * 1024;

/** Content types whose bodies are safe and useful to inline as text. */
const TEXT_CONTENT_TYPE_RE =
  /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|typescript|x-sh|toml|csv))/i;
/** File-name extensions treated as text when the content type is unknown. */
const TEXT_EXT_RE =
  /\.(txt|md|markdown|mdx|json|ya?ml|toml|csv|tsv|xml|html?|css|js|ts|tsx|jsx|py|rb|go|rs|java|sql|sh|env|ini|conf|log)$/i;

function isTextual(file: KnowledgeFile): boolean {
  if (file.contentType && TEXT_CONTENT_TYPE_RE.test(file.contentType)) {
    return true;
  }
  return TEXT_EXT_RE.test(file.name);
}

function describe(file: KnowledgeFile): string {
  const parts = [file.contentType ?? "unknown type"];
  if (file.size != null) parts.push(`${file.size} bytes`);
  return parts.join(", ");
}

/**
 * Build the `<knowledge>` block for an agent, or `null` when the agent has no
 * attached files (or storage is unavailable, e.g. in unit tests).
 */
export async function buildKnowledgeBlock(
  ctx: StudioContext,
  organization: OrganizationScope,
  agentId: string,
): Promise<string | null> {
  const findById = ctx?.storage?.virtualMcps?.findById;
  if (typeof findById !== "function") return null;

  let files: KnowledgeFile[] = [];
  try {
    const agent = await ctx.storage.virtualMcps.findById(
      agentId,
      organization.id,
    );
    files = agent?.metadata?.knowledge ?? [];
  } catch {
    return null;
  }
  if (files.length === 0) return null;

  const orgSlug = organization.slug ?? "";
  const docs = files.filter((f) => f.kind !== "skill");
  const skills = files.filter((f) => f.kind === "skill");

  // Inventory: every item, always, with the exact sandbox path so the agent
  // can open it directly with its file tools. This is what makes the agent
  // aware of the full set of reference material it has, regardless of inlining.
  const docInventory = docs
    .map(
      (f) =>
        `- ${f.name} (${describe(f)}), read at \`${orgFsSandboxPath(f.volume, f.path, orgSlug)}\``,
    )
    .join("\n");
  const skillInventory = skills
    .map(
      (s) =>
        `- ${s.name}: a skill at \`${orgFsSandboxPath(s.volume, s.path, orgSlug)}\`; read its \`SKILL.md\` before applying it`,
    )
    .join("\n");

  // Inlined contents for the readable text docs, within budget. Content is
  // read straight from the org filesystem via ctx (the Library's storage), so
  // it works in dev + prod with no presigned URL or network round-trip. Only
  // docs (org-scoped volumes) are inlined; public-set items attach as skills,
  // which are inventoried, not inlined, so the org-scoped `ctx.orgFs` suffices.
  const orgFs = ctx.orgFs;
  let inlinedChars = 0;
  const inlined: string[] = [];

  for (const file of docs) {
    if (!isTextual(file)) continue;
    if (file.size != null && file.size > INLINE_PER_FILE_CHARS) continue;
    if (inlinedChars >= INLINE_TOTAL_CHARS) break;

    const content = await readText(orgFs, file.volume, file.path);
    if (content == null) continue;

    const truncated = content.slice(0, INLINE_PER_FILE_CHARS);
    inlinedChars += truncated.length;
    const note =
      truncated.length < content.length ? "\n\n[content truncated]" : "";
    inlined.push(`## ${file.name}\n\n\`\`\`\n${truncated}${note}\n\`\`\``);
  }

  const lines = [
    "<knowledge>",
    "The following files and skills are attached to you as reference knowledge. Always treat them as available, authoritative reference material, and read them when relevant to the task.",
  ];

  if (docInventory) {
    lines.push("", "Attached files:", docInventory);
  }
  if (skillInventory) {
    lines.push("", "Attached skills:", skillInventory);
  }

  if (inlined.length > 0) {
    lines.push(
      "",
      "Contents of the text files are included below for convenience. Files listed above without contents here are attached but not inlined (binary or too large); read them from their sandbox path when needed.",
      "",
      inlined.join("\n\n"),
    );
  }

  lines.push("</knowledge>");
  return lines.join("\n");
}

/** Read an org-fs file as text, returning null on any failure. */
async function readText(
  orgFs: StudioContext["orgFs"],
  volume: string,
  path: string,
): Promise<string | null> {
  if (!orgFs) return null;
  try {
    const bytes = await orgFs.read(volume, path);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
