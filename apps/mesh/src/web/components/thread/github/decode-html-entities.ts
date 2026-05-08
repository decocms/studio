/**
 * Decodes a narrow, static set of HTML entities we see in GitHub API
 * responses (titles/bodies that were HTML-escaped by something upstream).
 *
 * Intentionally NOT a full HTML parser — we just want literal `&#34;` to
 * render as `"` in the PR panel, with no DOM dependency so the util is
 * testable under bun:test.
 */
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

export function decodeHtmlEntities(input: string | null | undefined): string {
  if (!input) return "";
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const cp = Number.parseInt(body.slice(2), 16);
      if (!Number.isFinite(cp)) return match;
      return String.fromCodePoint(cp);
    }
    if (body.startsWith("#")) {
      const cp = Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp)) return match;
      return String.fromCodePoint(cp);
    }
    return NAMED[body] ?? match;
  });
}
