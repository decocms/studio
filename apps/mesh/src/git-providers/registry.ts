import { githubAdapter } from "./adapters/github";
import type { GitProviderAdapter, GitProviderId } from "./types";

/**
 * Registry of available git provider adapters.
 *
 * Today this is GitHub only. The shape exists so future adapters (GitLab,
 * Bitbucket, Gitea) plug in here. The `available` flag on `adapter.info`
 * reflects whether the adapter has its env vars set on the current instance
 * — that's how the Settings UI decides between "Connect" and "Not configured".
 */
export function getGitProviders(): Record<GitProviderId, GitProviderAdapter> {
  return {
    github: githubAdapter,
  };
}

export function getGitProvider(id: GitProviderId): GitProviderAdapter {
  const adapter = getGitProviders()[id];
  if (!adapter) throw new Error(`Unknown git provider: ${id}`);
  return adapter;
}
