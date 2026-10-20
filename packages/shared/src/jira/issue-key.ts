/**
 * The issue key out of whatever a person has in hand.
 *
 * They are as likely to paste the browser's URL as to type `ABC-123`, and Jira
 * keys are uppercase while nobody types them that way, so normalizing here
 * keeps every caller from guessing. Anything that is not a key is rejected
 * rather than passed to Jira as a search term.
 */

/** `PROJ-123` — a project key (letters/digits/underscore, starting with a
 *  letter) then a number. */
const ISSUE_KEY = /^([A-Za-z][A-Za-z0-9_]*-\d+)$/;

export function parseIssueKey(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  // A pasted link: .../browse/ABC-123, or a board URL with ?selectedIssue=ABC-123.
  const fromUrl =
    /(?:\/(?:browse|issues)\/|[?&]selectedIssue=)([A-Za-z][A-Za-z0-9_]*-\d+)/.exec(
      trimmed,
    );
  const candidate = fromUrl?.[1] ?? trimmed.split(/[?#]/)[0] ?? "";
  const match = ISSUE_KEY.exec(candidate);
  return match?.[1] ? match[1].toUpperCase() : null;
}

/**
 * Every issue key in a pasted blob, in order, without repeats.
 *
 * A person naming several issues either pastes a column of links (newlines) or
 * types keys inline (commas), and a real paste is usually both plus stray
 * whitespace. Splitting on all three costs nothing to be liberal about: a key
 * can contain none of them, and a URL's own separators (`?`, `#`, `/`) are not
 * among them, so a pasted link survives intact to `parseIssueKey`.
 *
 * Unparseable pieces come back in `invalid` rather than being dropped. A typo
 * in one line of ten must be visible — silently starting nine runs and saying
 * nothing about the tenth is the failure this exists to prevent.
 */
export function parseIssueKeys(raw: string): {
  keys: string[];
  invalid: string[];
} {
  const keys: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const piece of raw.split(/[\n,;]+/)) {
    const trimmed = piece.trim();
    if (trimmed === "") continue;
    const key = parseIssueKey(trimmed);
    if (!key) {
      invalid.push(trimmed);
      continue;
    }
    // The same issue named twice is one run: firing it twice would have the
    // second supersede the first, which is a slower way of doing nothing.
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return { keys, invalid };
}
