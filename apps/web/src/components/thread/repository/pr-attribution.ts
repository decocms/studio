/**
 * Who a merged PR should be attributed to in the publish popover's
 * "Last published … by …" line.
 *
 * The PR's `user.login` is whatever identity the GitHub connection acts as —
 * often the GitHub App, not the person. Studio stamps the human into the PR
 * body as a `Co-authored-by` trailer (see `appendCoAuthorToPullRequestBody`),
 * so that trailer is the primary source; `user.login` is only a fallback, and
 * a bot login is never shown.
 */

const CO_AUTHOR_TRAILER_RE =
  /^Co-authored-by:\s*([^<\r\n]+?)(?:\s*<[^>\r\n]*>)?\s*$/im;

/** Human name from a PR body's Co-authored-by trailer, or null. */
export function coAuthorNameFromPrBody(
  body: string | null | undefined,
): string | null {
  if (!body) return null;
  const name = CO_AUTHOR_TRAILER_RE.exec(body)?.[1]?.trim();
  return name ? name : null;
}

function isBotLogin(login: string): boolean {
  return /\[bot\]$/i.test(login) || /-bot$/i.test(login);
}

/**
 * Display name for the "by <name>" clause, or null to drop the clause
 * entirely (no trailer and the PR author looks like a bot / is empty).
 */
export function lastPublishAttribution(pr: {
  author: string;
  body: string;
}): string | null {
  const coAuthor = coAuthorNameFromPrBody(pr.body);
  if (coAuthor) return coAuthor;
  const author = pr.author.trim();
  if (!author || isBotLogin(author)) return null;
  return author;
}
