/**
 * Board links → Jira remote links (the issue's "Web links" panel), so someone
 * reading the ticket reaches the PR and its deploy preview without opening
 * Studio.
 *
 * `globalId` is the upsert key: Jira replaces the link already carrying it
 * instead of appending a duplicate. That is what makes the push a retriable
 * step, and what lets a re-deploy's preview overwrite the previous one in
 * place rather than stacking a link per deploy.
 *
 * Pure and deterministic, because the push workflow turns each entry into its
 * own durable step and dedupes its enqueue on the plan — the same input must
 * always yield the same links in the same order.
 */

import { isTrustedPreviewHost } from "../tools/task-board/prs-get";

export interface JiraRemoteLink {
  globalId: string;
  url: string;
  title: string;
  iconUrl?: string;
}

const GITHUB_ICON = "https://github.githubassets.com/favicon.ico";

export interface RemoteLinkInput {
  taskBoardItemId: string;
  prUrl?: string | null;
  prNumber?: number | null;
  previewUrl?: string | null;
}

export function remoteLinkPlan(input: RemoteLinkInput): JiraRemoteLink[] {
  const links: JiraRemoteLink[] = [];
  // Keyed by PR number, not by url: a card can link more than one PR and each
  // gets its own row, while a re-push of the same PR updates in place.
  if (input.prUrl && isHttpUrl(input.prUrl)) {
    links.push({
      globalId: `studio-pr:${input.taskBoardItemId}:${input.prNumber ?? input.prUrl}`,
      url: input.prUrl,
      title: input.prNumber
        ? `Pull request #${input.prNumber}`
        : "Pull request",
      iconUrl: GITHUB_ICON,
    });
  }
  // Host-checked at the write, not just where it was read: a preview is lifted
  // from PR comments an external contributor can author, and this one lands on
  // a customer's issue as a link people click.
  if (
    input.previewUrl &&
    isHttpUrl(input.previewUrl) &&
    isTrustedPreviewHost(input.previewUrl)
  ) {
    links.push({
      // One preview link per card, so a new deploy replaces the old URL.
      globalId: `studio-preview:${input.taskBoardItemId}`,
      url: input.previewUrl,
      title: "Deploy preview",
    });
  }
  return links;
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}
