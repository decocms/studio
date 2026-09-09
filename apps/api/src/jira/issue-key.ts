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
