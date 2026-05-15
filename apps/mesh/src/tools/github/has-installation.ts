/**
 * Lightweight "does this GitHub connection have an installation on
 * `<login>`?" probe. Used by visibility predicates that want to gate UI
 * on whether the user can reach a specific GitHub org (e.g. the
 * "Set up error monitoring" preset card, scoped to `deco-sites`).
 *
 * Why not reuse GITHUB_LIST_USER_ORGS: that tool is an MCP tool with
 * defineTool's authz/audit/tracing scaffolding. For an `isApplicable`
 * predicate we want a side-effect-free function returning a bool, with
 * a no-throw failure mode (a flaky GitHub call should hide the card,
 * not 500 the home page). Same token-refresh path so the behavior
 * stays consistent across both code paths.
 */

import {
  canRefresh,
  PROACTIVE_REFRESH_BUFFER_MS,
  refreshAndStore,
} from "@/oauth/token-refresh";
import type { MeshContext } from "@/core/mesh-context";
import { DownstreamTokenStorage } from "@/storage/downstream-token";

const GITHUB_API = "https://api.github.com";

interface InstallationsResponse {
  installations: Array<{ account: { login: string } }>;
}

export async function hasGithubInstallationOn(
  connectionId: string,
  login: string,
  ctx: MeshContext,
): Promise<boolean> {
  try {
    const tokenStorage = new DownstreamTokenStorage(ctx.db, ctx.vault);
    const token = await tokenStorage.get(connectionId);
    if (!token) return false;

    let accessToken = token.accessToken;
    if (
      canRefresh(token) &&
      tokenStorage.isExpired(token, PROACTIVE_REFRESH_BUFFER_MS)
    ) {
      const refreshed = await refreshAndStore(token, tokenStorage);
      if (!refreshed) return false;
      accessToken = refreshed;
    }

    // 100 per page is the GitHub max; one page is enough for a
    // "does any installation match" check — no one has 100+ installs.
    const res = await fetch(`${GITHUB_API}/user/installations?per_page=100`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) return false;
    const data = (await res.json()) as InstallationsResponse;
    return data.installations.some((i) => i.account.login === login);
  } catch (err) {
    console.warn(
      `[has-installation] probe failed for conn ${connectionId} / login ${login}:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
