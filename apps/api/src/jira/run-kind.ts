/**
 * What a Jira-triggered run is for.
 *
 * The team's process is two columns and two runs, not one thread that both
 * implements and reviews itself — that shape only ever came from firing runs
 * by hand. A rule therefore declares which half of it the column is:
 *
 * - `execute` — implement the issue, open a pull request, hand over.
 * - `review` — take the pull request that run left, review the code and QA it
 *   on the deploy preview, and record the verdict on the issue.
 *
 * The two need opposite closing instructions (a reviewer that opens its own
 * pull request has reviewed nothing), so the kind reaches the prompt builder
 * rather than being something the rule's wording has to imply.
 */

export const JIRA_RUN_KINDS = ["execute", "review"] as const;

export type JiraRunKind = (typeof JIRA_RUN_KINDS)[number];

/** Row values predate the column, so anything unreadable is the old behaviour. */
export function asJiraRunKind(value: string | null | undefined): JiraRunKind {
  return value === "review" ? "review" : "execute";
}
