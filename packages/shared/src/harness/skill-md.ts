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

export interface SkillMeta {
  name: string | null;
  description: string | null;
  /** Markdown body with the frontmatter fence stripped. */
  body: string;
}

/** Flat `key: value` frontmatter subset — skill files don't nest. */
function parseFrontmatter(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (m?.[1] && m[2] !== undefined) {
      out[m[1].toLowerCase()] = m[2].trim();
    }
  }
  return out;
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
      description: firstParagraph(text),
      body: text,
    };
  }
  const fm = parseFrontmatter(m[1]);
  const body = text.slice(m[0].length);
  return {
    name: fm.name || null,
    description: fm.description || firstParagraph(body),
    body,
  };
}
