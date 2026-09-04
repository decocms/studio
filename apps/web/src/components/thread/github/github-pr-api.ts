/**
 * Opening and landing a change request from the browser.
 *
 * It used to hold a GitHub MCP client and call `create_pull_request`,
 * `update_pull_request` and `merge_pull_request` by name — which is why a
 * GitLab project's publish had nothing to call. Both operations are now Studio
 * tools over the provider interface, so the browser names an intention and the
 * repository decides the provider.
 *
 * The co-author trailer stays here: it is deco's convention about what a
 * publish credits, not something a provider knows.
 */

import { callStudioTool } from "@/lib/studio-tools";
import type { RepoToolTarget } from "@/lib/github-repo";
import type { TFunction } from "@/i18n/use-t.ts";
import {
  appendCoAuthorToPullRequestBody,
  appendCoAuthorTrailer,
  normalizeCoAuthorIdentity,
  type CoAuthorIdentity,
} from "@decocms/sandbox/shared";

export interface CreatedPullRequest {
  number: number;
  htmlUrl: string;
}

export interface OpenChangeRequestArgs {
  branch: string;
  title: string;
  body?: string;
  base: string;
  coAuthor?: CoAuthorIdentity;
}

/**
 * Propose `branch` onto `base`, or return the change request it already has.
 *
 * There is no duplicate to recover from any more: the server reuses the
 * branch's open one and reports `existed`, which is what the caller wanted
 * either way. That also retires the "refresh and try again" error this used to
 * raise when the caller's polled state was stale — the answer no longer
 * depends on what the browser happened to know.
 */
export async function openChangeRequestForBranch(
  orgSlug: string,
  target: RepoToolTarget,
  args: OpenChangeRequestArgs,
): Promise<CreatedPullRequest> {
  const coAuthor = normalizeCoAuthorIdentity(args.coAuthor);
  const { changeRequest } = await callStudioTool(
    orgSlug,
    "CHANGE_REQUEST_OPEN",
    {
      ...target,
      head: args.branch,
      base: args.base,
      title: args.title,
      body: appendCoAuthorToPullRequestBody(args.body, coAuthor) || undefined,
    },
  );
  return { number: changeRequest.number, htmlUrl: changeRequest.url };
}

export interface SquashMergeArgs {
  number: number;
  commitTitle?: string;
  commitMessage?: string;
  coAuthor?: CoAuthorIdentity;
}

export type MergeRefusalReason =
  | "conflict"
  | "blocked"
  | "rate_limited"
  | "not_found"
  | "error";

/**
 * A merge the provider refused. Carries the classified `reason` rather than a
 * finished sentence, because the sentence has to be translated where it is
 * shown; `detail` is the provider's own words, which stay untranslated the way
 * every other server-originated message does.
 */
export class ChangeRequestMergeRefused extends Error {
  readonly reason: MergeRefusalReason;
  readonly detail: string | undefined;
  constructor(reason: MergeRefusalReason, detail: string | undefined) {
    super(detail || `Merge refused: ${reason}`);
    this.name = "ChangeRequestMergeRefused";
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Land it as ONE commit — in Fast Preview a publish IS one commit on the base
 * branch, so the strategy is asked for by name rather than left to whatever
 * the repository allows.
 *
 * Throws {@link ChangeRequestMergeRefused} on a refusal: every caller here is
 * a person who just pressed Publish, and why it did not land is what they need
 * to read.
 */
export async function squashMergeChangeRequest(
  orgSlug: string,
  target: RepoToolTarget,
  args: SquashMergeArgs,
): Promise<void> {
  const coAuthor = normalizeCoAuthorIdentity(args.coAuthor);
  const commitMessage = coAuthor
    ? appendCoAuthorTrailer(args.commitMessage?.trim() ?? "", coAuthor)
    : args.commitMessage?.trim() || undefined;
  const outcome = await callStudioTool(orgSlug, "CHANGE_REQUEST_MERGE", {
    ...target,
    number: args.number,
    strategy: "squash",
    commitTitle: args.commitTitle,
    commitMessage,
  });
  if (!outcome.merged) {
    throw new ChangeRequestMergeRefused(
      outcome.reason ?? "error",
      outcome.detail,
    );
  }
}

/**
 * What a refusal reads as when the provider gave no detail of its own. The
 * `t` function comes from the calling surface — the reason travels as data
 * precisely so the sentence can be translated where it is shown.
 */
export function mergeRefusalText(
  reason: MergeRefusalReason,
  t: TFunction,
): string {
  switch (reason) {
    case "conflict":
      return t("thread.mergeRefused.conflict");
    case "blocked":
      return t("thread.mergeRefused.blocked");
    case "rate_limited":
      return t("thread.mergeRefused.rateLimited");
    case "not_found":
      return t("thread.mergeRefused.notFound");
    default:
      return t("thread.mergeRefused.error");
  }
}
