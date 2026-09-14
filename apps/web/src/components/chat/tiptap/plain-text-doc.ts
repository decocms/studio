/**
 * Plain text ↔ Tiptap doc, for the prompt fields that STORE a string.
 *
 * The chat's composer stores its doc, so a mention stays a chip across
 * reloads. A saved prompt — a Jira column rule, say — is a string the server
 * reads, and it must stay one: the whole reason for editing it in this editor
 * is the `/` menu, which fetches a skill's files when you pick it. Once here
 * the words are yours, and they round-trip as words.
 *
 * So the chip is an insertion affordance, not a stored reference. Reopen the
 * field and you see what the run will see, which is the point.
 */

import { parseSkillMd } from "@decocms/shared/harness/skill-md";
import type { TiptapDoc, TiptapNode } from "@decocms/shared/tiptap";

/** One paragraph per line; an empty line is an empty paragraph, so blank-line
 *  structure (markdown's paragraph break) survives the round trip. */
export function plainTextToTiptapDoc(text: string): TiptapDoc {
  return {
    type: "doc",
    content: text.split("\n").map((line) => ({
      type: "paragraph",
      ...(line === "" ? {} : { content: [{ type: "text", text: line }] }),
    })),
  };
}

/** Node types that occupy their own line — tiptap keeps no newline of its own,
 *  the break IS the block boundary. */
const BLOCK_NODES = new Set(["paragraph", "heading", "codeBlock", "listItem"]);

interface SkillMentionAttrs {
  files?: Array<{ relPath: string; content: string }>;
}

/**
 * What a skill contributes: its SKILL.md BODY, plus any sibling doc.
 *
 * Deliberately not `derive-parts`' rendering, which wraps each file in a
 * `<skill-file path=…>` delimiter and repeats the mention's label — right for a
 * chat message, wrong for a prompt someone is about to read and edit. The
 * frontmatter goes too: `name` and `description` exist to help a model FIND the
 * skill, and `disable-model-invocation` is a statement about this catalog, not
 * an instruction to anyone.
 */
function skillText(attrs: SkillMentionAttrs): string {
  const files = (attrs.files ?? []).filter((f) => f.content?.trim());
  return files
    .map((f) =>
      f.relPath === "SKILL.md"
        ? parseSkillMd(f.content).body.trim()
        : `${f.relPath}:\n${f.content.trim()}`,
    )
    .join("\n\n");
}

/** The text a run would receive, with every mention already expanded. */
export function tiptapDocToPlainText(doc: TiptapDoc | undefined): string {
  if (!doc) return "";
  let out = "";
  const walk = (node: TiptapNode) => {
    if (BLOCK_NODES.has(node.type ?? "") && out !== "") out += "\n";
    if (node.type === "hardBreak") {
      out += "\n";
    } else if (node.type === "text" && typeof node.text === "string") {
      out += node.text;
    } else if (node.type === "mention") {
      const attrs = (node.attrs ?? {}) as {
        kind?: string;
        name?: string;
        char?: string;
        metadata?: unknown;
      };
      // Only a skill carries its content in the doc. Anything else (a prompt,
      // a resource, an @-mention) is resolved elsewhere or at send time, so the
      // honest thing to leave behind is its label.
      const baked =
        attrs.kind === "skill"
          ? skillText((attrs.metadata ?? {}) as SkillMentionAttrs)
          : "";
      out += baked || `${attrs.char ?? "/"}${attrs.name ?? ""}`;
    }
    for (const child of node.content ?? []) walk(child);
  };
  for (const child of doc.content) walk(child);
  return out.trim();
}
