/**
 * The pull request an issue carries, out of its web links.
 *
 * This is the whole join between a Jira issue and a repository. The runs put
 * it there themselves (`JIRA_REMOTE_LINK_ADD`), and nothing else records it:
 * the anchor item deliberately has no linked pull requests, because the board
 * reactions that used to keep them are off for Jira — a reviewer once picked
 * up the pull request of a PRIOR run and reproved the wrong card.
 *
 * So the issue is the source of truth, and this reads it.
 */

import { parseChangeRequestUrl } from "@decocms/shared/git-providers/change-request-ref";
import type { ChangeRequestRef } from "@decocms/shared/git-providers/change-request-ref";

/**
 * The newest change request among `links`, or null when the issue names none.
 *
 * LAST wins, because Jira returns web links oldest-first and a card routinely
 * carries more than one: an older pull request from a superseded run, or one
 * a person added from somewhere else entirely. The one the latest run opened
 * is the one to act on, and it is the one added last.
 */
export function pullRequestFromLinks(
  links: ReadonlyArray<{ url: string }>,
): ChangeRequestRef | null {
  let found: ChangeRequestRef | null = null;
  for (const link of links) {
    const ref = parseChangeRequestUrl(link.url);
    if (ref) found = ref;
  }
  return found;
}
