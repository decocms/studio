import type { GithubRepo } from "@decocms/mesh-sdk/types";
import type { SandboxProvider } from "@decocms/sandbox/provider";
import type { StudioContext } from "../../core/studio-context";
import { buildCloneInfo } from "../../shared/github-clone-info";

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
 * Refreshes the OAuth token baked into the sandbox clone URL and patches the
 * running daemon config so git push can sync `origin` before publishing.
 */
export async function refreshSandboxGitCredentials(
  ctx: StudioContext,
  runner: SandboxProvider,
  handle: string,
  githubRepo: GithubRepo,
): Promise<void> {
  if (!githubRepo.connectionId) {
    throw new GitPushAuthError(
      "Push requires a connected GitHub account. Connect mcp-github for this project and restart the sandbox.",
    );
  }

  const { cloneUrl, gitUserName, gitUserEmail } = await buildCloneInfo(
    githubRepo.connectionId,
    githubRepo.owner,
    githubRepo.name,
    ctx.db,
    ctx.vault,
  );

  const res = await runner.proxyDaemonRequest(handle, "/_sandbox/config", {
    method: "PUT",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      git: {
        repository: { cloneUrl },
        identity: { userName: gitUserName, userEmail: gitUserEmail },
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(
      `Failed to refresh sandbox git credentials (${res.status}): ${body}`,
    );
  }
}
