import type { GithubRepo } from "@decocms/shared/sdk/types";
import type { AgentSandboxProvider } from "@decocms/sandbox/provider/agent-sandbox";
import type { StudioContext } from "../../core/studio-context";
import { RECONNECT_ERROR } from "../../oauth/token-refresh";
import { coAuthorFromStudioContext } from "../../lib/co-author-identity";
import { readBoundedText } from "../../lib/bounded-text";
import {
  buildCloneInfo,
  ensureGithubCloneToken,
} from "../../shared/github-clone-info";

/** Matches the cap `sandbox-proxy.ts` applies to `/_sandbox/config` responses. */
const CONFIG_RESPONSE_MAX_BYTES = 10 * 1024 * 1024;

export class GitPushAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitPushAuthError";
  }
}

export function parseGithubRepoFromMetadata(
  metadata: Record<string, unknown> | null,
  connectionIds: readonly string[],
): GithubRepo | null {
  const repo = metadata?.githubRepo as GithubRepo | undefined;
  if (!repo?.owner || !repo?.name) return null;
  if (!repo.connectionId) return repo;
  if (!connectionIds.includes(repo.connectionId)) return null;
  return repo;
}

/**
 * Refreshes the GitHub token baked into the sandbox clone URL and patches the
 * running daemon config so git push can sync `origin` before publishing.
 * buildCloneInfo owns token refresh before baking the clone URL.
 */
export async function refreshSandboxGitCredentials(
  ctx: StudioContext,
  runner: AgentSandboxProvider,
  handle: string,
  githubRepo: GithubRepo,
): Promise<void> {
  if (!githubRepo.connectionId) {
    throw new GitPushAuthError(
      "Push requires a connected GitHub account. Connect mcp-github for this project and restart the sandbox.",
    );
  }

  const organizationId = ctx.organization?.id;
  if (!organizationId) {
    throw new GitPushAuthError(RECONNECT_ERROR);
  }

  await ensureGithubCloneToken({
    ctx,
    connectionId: githubRepo.connectionId,
    organizationId,
    forceRefresh: true,
    onLegacyMintError: (error) => {
      const message = error instanceof Error ? error.message : RECONNECT_ERROR;
      throw new GitPushAuthError(message);
    },
  });

  const { cloneUrl, gitUserName, gitUserEmail } = await buildCloneInfo(
    githubRepo.connectionId,
    githubRepo.owner,
    githubRepo.name,
    ctx.db,
    ctx.vault,
  );

  const operator = coAuthorFromStudioContext(ctx);

  const res = await runner.proxyDaemonRequest(handle, "/_sandbox/config", {
    method: "PUT",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      git: {
        repository: { cloneUrl },
        identity: { userName: gitUserName, userEmail: gitUserEmail },
      },
      ...(operator ? { operator } : {}),
    }),
  });

  if (!res.ok) {
    const body = await readBoundedText(res, CONFIG_RESPONSE_MAX_BYTES).catch(
      () => res.statusText,
    );
    throw new Error(
      `Failed to refresh sandbox git credentials (${res.status}): ${body}`,
    );
  }
}
