/**
 * Finding a change request's identity in whatever a run happened to produce.
 *
 * Every "the agent opened one" scenario collapses to the same primitive: find
 * a change request URL in a string. A provider MCP tool result (a minimal
 * `{ id, url }`, or a `{ number, html_url }`, or plain text), `gh pr create` /
 * `glab mr create` stdout (both print the URL), and a raw
 * `curl -X POST …/pulls` or `…/merge_requests` response body all embed one. So
 * we stringify whatever we have and scan it — no per-shape branching, and no
 * per-provider branching either: the URL says which provider it is.
 */

import {
  type ChangeRequestRef,
  findChangeRequestUrl,
  parseRepoUrl,
  repoRefFromOwnerName,
} from "@decocms/shared/git-providers";
import type { ChangeRequestOrigin } from "@/git-providers";
import type { TaskBoardItemPrRef } from "@/storage/types";

export type { ChangeRequestRef };

/** Stringify any tool result / bash output and scan it for a change request. */
export function findChangeRequestIn(value: unknown): ChangeRequestRef | null {
  if (value == null) return null;
  if (typeof value === "string") return findChangeRequestUrl(value);
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return null;
  }
  return text ? findChangeRequestUrl(text) : null;
}

/**
 * Which repository a linked row points at, and which credential reads it.
 *
 * The url is the source of truth for identity, because it carries the host and
 * therefore the provider. `repoOwner`/`repoName` are the fallback for rows
 * written before the url was canonicalised — those are all GitHub, which is
 * why assuming that provider there is safe.
 */
export function originOf(pr: TaskBoardItemPrRef): ChangeRequestOrigin {
  return {
    repo:
      parseRepoUrl(pr.url) ?? repoRefFromOwnerName(pr.repoOwner, pr.repoName),
    repositoryId: pr.repositoryId,
    connectionId: pr.connectionId,
  };
}
