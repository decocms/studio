/**
 * The open pull request(s) a Jira issue is continuing, ready to hand to a run.
 *
 * A re-run after a review asked for changes must push to the pull request that
 * was reviewed, not open a second one — and naming a pull request the sandbox
 * is NOT booted on is precisely the combination that produced duplicates on
 * the board path. So this resolves the head BRANCH too, straight from the
 * provider: `resolveRerunBranch` reads the board's linked pull requests, and a
 * Jira anchor deliberately has none.
 *
 * An issue can carry one open pull request per repository — a reciprocal
 * change spans both storefronts. The sandbox pins to ONE branch, so the first
 * is the run's own and the rest are `others`: the prompt names them with their
 * branches, and the run checks each out after cloning its repository.
 *
 * Null when there is nothing open to continue. A run that gets null behaves
 * exactly as it does today (a fresh branch and a new pull request), which is
 * never WRONG, only wasteful. A run that gets a wrong branch pushes commits
 * nobody asked for onto someone else's work.
 */

import type { StudioContext } from "@/core/studio-context";
import { changeRequestClientForOrigin } from "@/git-providers";
import type { JiraClient } from "./client";
import { pullRequestsFromLinks } from "./pr-link";

export interface ContinuedPr {
  number: number;
  url: string;
  head: string;
}

export interface ContinuablePr extends ContinuedPr {
  /** Open pull requests in the issue's OTHER repositories. */
  others: Array<ContinuedPr & { repo: string }>;
}

export async function openPrForIssue(
  ctx: StudioContext,
  organizationId: string,
  jira: JiraClient,
  issueKey: string,
): Promise<ContinuablePr | null> {
  try {
    const open: Array<ContinuedPr & { repo: string }> = [];
    for (const ref of pullRequestsFromLinks(
      await jira.listRemoteLinks(issueKey),
    )) {
      const client = await changeRequestClientForOrigin(ctx, organizationId, {
        repo: ref.repo,
      });
      if (!client) continue;
      const pr = await client.read(ref.number);
      // Closed or merged is not continued: a person ended that one on purpose.
      if (!pr || pr.state !== "open" || !pr.head) continue;
      open.push({
        number: ref.number,
        url: ref.url,
        head: pr.head,
        repo: ref.repo.path,
      });
    }
    const [primary, ...others] = open;
    if (!primary) return null;
    return {
      number: primary.number,
      url: primary.url,
      head: primary.head,
      others,
    };
  } catch {
    // Best-effort by design: a provider hiccup costs a duplicate pull request,
    // which a person can close. Failing the run costs the work.
    return null;
  }
}
