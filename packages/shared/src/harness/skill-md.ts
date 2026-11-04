/**
 * SKILL.md parsing — the Claude Code skill format: optional flat YAML
 * frontmatter (`name`, `description`, …) followed by a markdown body.
 * Some first-party skills skip the frontmatter entirely (plain markdown),
 * so everything degrades: name falls back to the dir name (caller's job),
 * description falls back to the first body paragraph.
 *
 * Pure and zero-dependency so it is shared by the studio server (skill
 * catalog) and the web Library, with no DOM/Node coupling.
 */

import { isSkillCategory } from "../skills";

export interface SkillMeta {
  name: string | null;
  /** Short display name for people (`title:`); `name` stays the id-like slug. */
  title: string | null;
  description: string | null;
  /** One of `SKILL_CATEGORY_IDS` (`category:`); anything else reads as null. */
  category: string | null;
  /** Bundle ids the skill belongs to (`bundles: [a, b]`). */
  bundles: string[];
  /**
   * `disable-model-invocation: true` — the skill is for a person to reach
   * for, not for the model to discover. It stays out of the `<available-skills>`
   * catalog and out of the `skill` tool, and is offered only where a person
   * picks one by hand (the `/` menu). The convention is Claude Code's.
   *
   * A skill whose whole job is to BE the text of a prompt someone writes is
   * the case this exists for: advertising it to every run of every org is the
   * implicit context it was written to replace.
   */
  disableModelInvocation: boolean;
  /** Markdown body with the frontmatter fence stripped. */
  body: string;
}

/** `"a: b"` / `'a'` → the text inside: a value with `: ` in it has to be
 *  quoted to stay valid YAML, and the quotes are not part of it. */
function unquote(value: string): string {
  const m = value.match(/^(["'])([\s\S]*)\1$/);
  return m?.[2] ?? value;
}

/** Flat `key: value` frontmatter subset — skill files don't nest. */
function parseFrontmatter(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (m?.[1] && m[2] !== undefined) {
      out[m[1].toLowerCase()] = unquote(m[2].trim());
    }
  }
  return out;
}

/** `[a, b]` or `a, b` — the one list shape the flat frontmatter allows. */
function parseInlineList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((v) => v.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/** First non-heading paragraph of a markdown body (description fallback). */
function firstParagraph(body: string): string | null {
  for (const block of body.split(/\n\s*\n/)) {
    const text = block.trim();
    if (!text || text.startsWith("#")) continue;
    return text.replace(/\n/g, " ");
  }
  return null;
}

export function parseSkillMd(text: string): SkillMeta {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m || m[1] === undefined) {
    return {
      name: null,
      title: null,
      description: firstParagraph(text),
      category: null,
      bundles: [],
      disableModelInvocation: false,
      body: text,
    };
  }
  const fm = parseFrontmatter(m[1]);
  const body = text.slice(m[0].length);
  return {
    name: fm.name || null,
    title: fm.title || null,
    description: fm.description || firstParagraph(body),
    category: isSkillCategory(fm.category) ? fm.category : null,
    bundles: parseInlineList(fm.bundles),
    // Anything but an explicit `true` leaves the skill discoverable: hiding a
    // skill on a typo is the failure nobody would go looking for.
    disableModelInvocation: fm["disable-model-invocation"] === "true",
    body,
  };
}
