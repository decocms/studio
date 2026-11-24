/**
 * The schema of a pull request draft's site: its pull request's deploy
 * preview runs the pull request's code, so its `/live/_meta` names the
 * sections and props the pull request adds or changes. Production's does not.
 *
 * The preview is resolved here from the provider, never from the request. The
 * admin token is one secret for every site, so it travels only to a preview
 * deco hosting itself reported for the org's own site: a commit status or a
 * deployment someone else posted can name any host.
 */

import { isPullRequestDraftBranch } from "@decocms/shared/thread/session-runtime";
import type { StudioContext } from "@/core/studio-context";
import {
  changeRequestClientForTarget,
  type DeploymentPreview,
  repoTargetForBinding,
} from "@/git-providers";
import {
  changeRequestPreview,
  isTrustedPreviewHost,
} from "@/git-providers/preview-url";
import { parseRepositoryBinding } from "@/tools/sandbox/sync-git-credentials";
import { isTrustedSiteOrigin, type SiteMetaTarget } from "./site-meta-request";

/** The GitHub App deco hosting reports its deployments as. */
export const DECO_HOSTING_REPORTER = "deco-hosting[bot]";

/**
 * Where to read the pull request's schema, and whether the admin token may go
 * with it: only to the org's own site's preview on deco's platform host, as
 * deco hosting reported it for the pull request's head.
 */
export function pullRequestMetaTarget(input: {
  /** The preview its CI runs link, if any. */
  linkedUrl: string | null;
  /** Its head's deployment; read when the token could be at stake. */
  deployment: DeploymentPreview | null;
  siteSlug: string | null;
  orgOwnsSite: boolean;
}): SiteMetaTarget | null {
  const { deployment, siteSlug } = input;
  const reported = deployment?.state === "ready" ? deployment : null;
  const url = input.linkedUrl ?? reported?.url ?? null;
  if (!url || !isTrustedPreviewHost(url)) return null;
  const trusted =
    input.orgOwnsSite &&
    !!siteSlug &&
    reported?.url === url &&
    reported.reporter === DECO_HOSTING_REPORTER &&
    isTrustedSiteOrigin(url) &&
    new URL(url).hostname.startsWith(`${siteSlug}-`);
  return { siteUrl: url, trusted };
}

/** {@link pullRequestMetaTarget} for a session's branch; null when the
 *  branch is not a pull request draft or its preview cannot be read. */
export async function resolvePullRequestMetaTarget(
  ctx: StudioContext,
  input: {
    organizationId: string;
    metadata: Record<string, unknown> | null;
    connectionIds: readonly string[];
    branch: string;
    siteSlug: string | null;
    orgOwnsSite: boolean;
  },
): Promise<SiteMetaTarget | null> {
  if (!isPullRequestDraftBranch(input.metadata, input.branch)) return null;
  const repository = parseRepositoryBinding(
    input.metadata,
    input.connectionIds,
  );
  if (!repository) return null;
  const client = await changeRequestClientForTarget(
    ctx,
    input.organizationId,
    repoTargetForBinding(repository),
  ).catch(() => null);
  if (!client) return null;
  const detail = await client
    .readDetailed({ branch: input.branch })
    .catch(() => null);
  if (!detail || detail.state !== "open") return null;
  const linked = changeRequestPreview(detail);
  const linkedUrl = linked.state === "ready" ? linked.url : null;
  const needsDeployment =
    !linkedUrl || (input.orgOwnsSite && isTrustedSiteOrigin(linkedUrl));
  const deployment = needsDeployment
    ? await client.readDeployment(detail.headSha).catch(() => null)
    : null;
  return pullRequestMetaTarget({
    linkedUrl,
    deployment,
    siteSlug: input.siteSlug,
    orgOwnsSite: input.orgOwnsSite,
  });
}
