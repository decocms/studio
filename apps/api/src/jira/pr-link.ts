/**
 * The pull requests an issue carries, out of its web links.
 *
 * This is the whole join between a Jira issue and a repository. The runs put
 * them there themselves (`JIRA_REMOTE_LINK_ADD`), and nothing else records
 * them: the anchor item deliberately has no linked pull requests, because the
 * board reactions that used to keep them are off for Jira — a reviewer once
 * picked up the pull request of a PRIOR run and reproved the wrong card.
 *
 * So the issue is the source of truth, and this reads it.
 */

import {
  type ChangeRequestRef,
  parseChangeRequestUrl,
} from "@decocms/shared/git-providers/change-request-ref";

/**
 * One pull request per repository — the highest-numbered of each.
 *
 * Both halves of that rule are load-bearing, and a card in the field proves
 * each:
 *
 * - **Per repository, not one overall.** A reciprocal-hreflang issue opened a
 *   pull request in the US storefront AND one in the BR one; both are the
 *   delivery. Landing only one there is worse than landing neither, because a
 *   hreflang declared on one side is not reciprocity, it is a broken signal.
 * - **Highest number within a repository.** Another issue carries three links
 *   to the same repo: the current attempt, a superseded one, and a closed one.
 *   Numbers are monotonic per repository, so the newest is the current attempt
 *   — and link ORDER cannot be trusted for this, since deleting and re-adding
 *   a link reorders them.
 *
 * A superseded attempt is deliberately NOT returned as a fallback when the
 * newest turns out to be closed. Reviving older work because the current
 * attempt was closed is a decision for a person, not a default.
 */
export function pullRequestsFromLinks(
  links: ReadonlyArray<{ url: string }>,
): ChangeRequestRef[] {
  const newestPerRepo = new Map<string, ChangeRequestRef>();
  for (const link of links) {
    const ref = parseChangeRequestUrl(link.url);
    if (!ref) continue;
    const key = `${ref.repo.host}/${ref.repo.path}`;
    const seen = newestPerRepo.get(key);
    if (!seen || ref.number > seen.number) newestPerRepo.set(key, ref);
  }
  // Stable output so a batch reports in the same order twice.
  return [...newestPerRepo.values()].sort((a, b) =>
    a.repo.path.localeCompare(b.repo.path),
  );
}
