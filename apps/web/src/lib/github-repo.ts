import type { GithubRepo, VirtualMCPEntity } from "@decocms/shared/sdk/types";

/**
 * The GitHub attachment status of a Virtual MCP, derived from a SINGLE source
 * of truth: the repo metadata cross-checked against the live `connections`
 * (direct aggregations). Previously several call sites re-interpreted
 * `metadata.githubRepo` + `connections` independently, which let them disagree
 * — the header could vanish entirely when the two drifted. Every consumer now
 * goes through `resolveGithubAttachment`.
 *
 *  - `none`         — no clonable GitHub repo metadata.
 *  - `public-clone` — repo linked without a connection (public template clone).
 *                     Bootable, but no authenticated PR/check actions.
 *  - `attached`     — repo linked via a GitHub connection that is still a live
 *                     aggregation of this Virtual MCP. Full header actions.
 *  - `detached`     — repo was linked via a GitHub connection (has an
 *                     installationId or a stored connectionId) but that
 *                     connection is no longer aggregated. Recoverable: the UI
 *                     surfaces a reconnect affordance instead of rendering
 *                     nothing.
 */
export type GithubAttachment =
  | { status: "none" }
  | { status: "public-clone"; repo: GithubRepo }
  | { status: "attached"; repo: GithubRepo; connectionId: string }
  | { status: "detached"; repo: GithubRepo };

export function resolveGithubAttachment(
  virtualMcp: VirtualMCPEntity | null | undefined,
): GithubAttachment {
  const repo = virtualMcp?.metadata?.githubRepo;
  if (!repo?.url) return { status: "none" };

  const connectionId = repo.connectionId;
  const attached =
    !!connectionId &&
    !!virtualMcp?.connections?.some((c) => c.connection_id === connectionId);
  if (attached) {
    return { status: "attached", repo, connectionId: connectionId! };
  }

  // Not currently aggregated. If the repo was ever linked with authenticated
  // credentials (installationId set at import, or a stale connectionId pointer),
  // it's a detached connection the user can reconnect — not a public clone.
  const wasConnected = !!connectionId || repo.installationId != null;
  return wasConnected
    ? { status: "detached", repo }
    : { status: "public-clone", repo };
}

/**
 * Returns the GitHub repo metadata when it's usable to boot a VM:
 *  - `public-clone`: unauthenticated git clone.
 *  - `attached`: authenticated clone via the still-attached connection.
 *
 * Returns null for `detached` (the token source is gone) and `none`.
 * Built on `resolveGithubAttachment` so this never disagrees with the header.
 */
export function getActiveGithubRepo(
  virtualMcp: VirtualMCPEntity | null | undefined,
): GithubRepo | null {
  const attachment = resolveGithubAttachment(virtualMcp);
  return attachment.status === "attached" ||
    attachment.status === "public-clone"
    ? attachment.repo
    : null;
}
