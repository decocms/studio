/**
 * The open pull request a Jira issue is continuing, ready to hand to a run.
 *
 * A re-run after a review asked for changes must push to the pull request that
 * was reviewed, not open a second one — and naming a pull request the sandbox
 * is NOT booted on is precisely the combination that produced duplicates on
 * the board path. So this resolves the head BRANCH too, straight from the
 * provider: `resolveRerunBranch` reads the board's linked pull requests, and a
 * Jira anchor deliberately has none.
 *
 * Null whenever the answer isn't unambiguous — no pull request, it is closed,
 * or the issue spans several repositories. A run that gets null behaves
 * exactly as it does today (a fresh branch and a new pull request), which is
 * never WRONG, only wasteful. A run that gets a wrong branch pushes commits
 * nobody asked for onto someone else's work.
 */

import type { StudioContext } from "@/core/studio-context";
import { changeRequestClientForOrigin } from "@/git-providers";
import type { JiraClient } from "./client";
import { pullRequestsFromLinks } from "./pr-link";

export interface ContinuablePr {
  number: number;
  url: string;
  head: string;
}

export async function openPrForIssue(
  ctx: StudioContext,
  organizationId: string,
  jira: JiraClient,
  issueKey: string,
): Promise<ContinuablePr | null> {
  try {
    const prs = pullRequestsFromLinks(await jira.listRemoteLinks(issueKey));
    // Several repositories is a real shape here — a reciprocal change spans
    // both storefronts — but `pr` names ONE, and its lead tells the run it is
    // already standing on that branch. It can only be standing on one, so the
    // honest answer for the others is to say nothing.
    if (prs.length !== 1) return null;
    const ref = prs[0]!;
    const client = await changeRequestClientForOrigin(ctx, organizationId, {
      repo: ref.repo,
    });
    if (!client) return null;
    const pr = await client.read(ref.number);
    if (!pr || pr.state !== "open" || !pr.head) return null;
    return { number: ref.number, url: ref.url, head: pr.head };
  } catch {
    // Best-effort by design: a provider hiccup costs a duplicate pull request,
    // which a person can close. Failing the run costs the work.
    return null;
  }
}
