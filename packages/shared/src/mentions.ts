/**
 * How an `@`-mention of a member is written into markdown, and how it's read
 * back out.
 *
 * A plain markdown link is the whole format: `[@Ana](mention:usr_123)`. The
 * body of a description or a comment is markdown everywhere else it's used —
 * fed to agents as prompt context, mirrored onto a Jira issue, rendered by a
 * markdown component that never heard of mentions — and a link degrades
 * legibly in all three. A bespoke syntax would render as literal punctuation
 * in every one of them.
 *
 * The id, not the name, is the mention: names repeat inside an org and change
 * afterwards, so who gets notified must not depend on either.
 */

export const MENTION_HREF_PREFIX = "mention:";

/** `[@Name](mention:id)`. The name may not contain `]`, the id may not contain
 *  `)` — both hold for user ids, and the editor escapes what it writes. */
const MENTION_RE = /\[@([^\]]+)\]\(mention:([^)\s]+)\)/g;

/**
 * No real comment/description mentions this many people. Caps the work done
 * per edit (a DB `IN` lookup and a notification fan-out per id) so a body
 * padded with thousands of fake `[@x](mention:id)` links can't blow either up.
 */
const MAX_MENTIONS = 50;

/** Every distinct user id mentioned in a markdown body, in first-seen order,
 *  capped at MAX_MENTIONS. */
export function parseMentions(markdown: string): string[] {
  const ids = new Set<string>();
  for (const m of markdown.matchAll(MENTION_RE)) {
    ids.add(m[2]!);
    if (ids.size >= MAX_MENTIONS) break;
  }
  return [...ids];
}

/** The markdown for one mention. */
export function mentionMarkdown(userId: string, name: string): string {
  // `]` would end the link text early and `[` would nest a link — neither can
  // appear in the output, so strip rather than escape (a name is a label here,
  // not content to preserve byte-for-byte).
  return `[@${name.replace(/[[\]]/g, "")}](${MENTION_HREF_PREFIX}${userId})`;
}

/** The user id in a `mention:` href, or null for any other link. */
export function mentionIdFromHref(href: string): string | null {
  return href.startsWith(MENTION_HREF_PREFIX)
    ? href.slice(MENTION_HREF_PREFIX.length)
    : null;
}
