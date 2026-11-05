import type { RepositoryBinding } from "@decocms/shared/sdk/types";
import type { SandboxProvider } from "@decocms/sandbox/provider/agent-sandbox";
import type { StudioContext } from "../../core/studio-context";
import { RECONNECT_ERROR } from "../../oauth/token-refresh";
import { coAuthorFromStudioContext } from "../../lib/co-author-identity";
import { readBoundedText } from "../../lib/bounded-text";
import { decodeSandboxStartError } from "@decocms/shared/sandbox-start-errors";
import {
  buildCloneInfo,
  ensureGithubCloneToken,
} from "../../shared/github-clone-info";
import {
  cloneInfoForRepository,
  findRepositoryForBinding,
  repositoryUsesStudioCredentials,
} from "@/git-providers";

/** Matches the cap `sandbox-proxy.ts` applies to `/_sandbox/config` responses. */
const CONFIG_RESPONSE_MAX_BYTES = 10 * 1024 * 1024;

export class GitPushAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitPushAuthError";
  }
}

export function parseRepositoryBinding(
  metadata: Record<string, unknown> | null,
  connectionIds: readonly string[],
): RepositoryBinding | null {
  const repo = metadata?.repository as RepositoryBinding | undefined;
  if (!repo?.owner || !repo?.name) return null;
  if (!repo.connectionId) return repo;
  if (!connectionIds.includes(repo.connectionId)) return null;
  return repo;
}

interface SandboxCloneInfo {
  cloneUrl: string;
  gitUserName: string;
  gitUserEmail: string;
}

/**
 * A sandbox being reused gets a clone URL whose token outlives a long turn's
 * last push; GitHub App installation tokens live about an hour.
 */
const REUSE_TOKEN_BUFFER_MS = 30 * 60_000;

/**
 * Refreshes the GitHub token baked into the sandbox clone URL and patches the
 * running daemon config so git push can sync `origin` before publishing.
 * buildCloneInfo owns token refresh before baking the clone URL.
 */
export async function refreshSandboxGitCredentials(
  ctx: StudioContext,
  runner: Pick<SandboxProvider, "proxyDaemonRequest">,
  handle: string,
  repository: RepositoryBinding,
): Promise<void> {
  const info = await resolveSandboxCloneInfo(ctx, repository, {
    forceRefresh: true,
  });
  const operator = coAuthorFromStudioContext(ctx);
  await putSandboxConfig(runner, handle, {
    git: {
      repository: { cloneUrl: info.cloneUrl },
      identity: { userName: info.gitUserName, userEmail: info.gitUserEmail },
    },
    ...(operator ? { operator } : {}),
  });
}

/**
 * Hands a sandbox that is being reused a clone URL with a live token. Only
 * `provider.ensure` bakes a fresh one, and reuse skips it, so without this a
 * long-lived VM keeps the token it was created with and every push fails once
 * that expires. The daemon ignores an unchanged URL, so a token still cached
 * costs one config request.
 */
export async function rotateReusedSandboxGitCredential(
  ctx: StudioContext,
  runner: Pick<SandboxProvider, "proxyDaemonRequest">,
  handle: string,
  repository: RepositoryBinding,
): Promise<void> {
  const { cloneUrl } = await resolveSandboxCloneInfo(ctx, repository, {
    bufferMs: REUSE_TOKEN_BUFFER_MS,
  });
  await putSandboxConfig(runner, handle, {
    git: { repository: { cloneUrl } },
  });
}

async function resolveSandboxCloneInfo(
  ctx: StudioContext,
  repository: RepositoryBinding,
  freshness: { forceRefresh: true } | { bufferMs: number },
): Promise<SandboxCloneInfo> {
  const organizationId = ctx.organization?.id;
  if (!organizationId) {
    throw new GitPushAuthError(RECONNECT_ERROR);
  }

  // Studio-owned credentials refresh through the repository's provider account.
  const repositoryRecord = await findRepositoryForBinding(
    ctx.storage,
    organizationId,
    repository,
  );
  if (
    repositoryRecord &&
    (await repositoryUsesStudioCredentials(ctx.storage, repositoryRecord))
  ) {
    return cloneInfoForRepository(ctx, repositoryRecord, freshness).catch(
      (error) => {
        throw new GitPushAuthError(
          error instanceof Error ? error.message : RECONNECT_ERROR,
        );
      },
    );
  }

  const connectionId =
    repository.connectionId ?? repositoryRecord?.legacyConnectionId;
  if (!connectionId) {
    throw new GitPushAuthError(
      "Push requires a connected git account. Connect the repository's provider for this project and restart the sandbox.",
    );
  }

  await ensureGithubCloneToken({
    ctx,
    connectionId,
    organizationId,
    forceRefresh: "forceRefresh" in freshness,
    onLegacyMintError: (error) => {
      const message = error instanceof Error ? error.message : RECONNECT_ERROR;
      throw new GitPushAuthError(message);
    },
  });

  return buildCloneInfo(
    connectionId,
    repository.owner,
    repository.name,
    ctx.db,
    ctx.vault,
    "bufferMs" in freshness ? { bufferMs: freshness.bufferMs } : undefined,
  ).catch((error) => {
    // Strip buildCloneInfo's SANDBOX_START_ERROR_CODES prefix so it doesn't leak raw into the publish-dialog UI.
    const { code, message } = decodeSandboxStartError(
      error instanceof Error ? error.message : String(error),
    );
    throw code ? new GitPushAuthError(message) : error;
  });
}

async function putSandboxConfig(
  runner: Pick<SandboxProvider, "proxyDaemonRequest">,
  handle: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const res = await runner.proxyDaemonRequest(handle, "/_sandbox/config", {
    method: "PUT",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(patch),
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
