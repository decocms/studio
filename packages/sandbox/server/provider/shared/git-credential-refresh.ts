import type { ConfigPatch } from "../../daemon-client";
import type { EnsureOptions } from "../types";

/** True when the clone URL embeds a credential (userinfo), e.g.
 * `https://x-access-token:TOKEN@github.com/owner/repo.git`. */
export function cloneUrlHasCredentials(cloneUrl: string): boolean {
  try {
    return new URL(cloneUrl).username.length > 0;
  } catch {
    return false;
  }
}

/**
 * The daemon `/config` patch that rotates the embedded git credential on a
 * resumed/adopted sandbox, or null when there's nothing to rotate.
 *
 * The clone token (`x-access-token:ghs_…`) is a ~1h GitHub App installation
 * token baked into `cloneUrl` at provision time. On a fresh provision it's
 * minted moments before use, but resume/adopt reuse the pod that already holds
 * the *original* (now-expired) token — so authenticated git (clone/fetch/push)
 * fails once it lapses. Every `SANDBOX_START` re-mints a fresh `opts.repo`
 * credential, so on resume/adopt we forward JUST the credentialed cloneUrl: the
 * daemon deep-merges it and classifies same-repo-path + new-token as a
 * `git-credential-refresh`, rotating `origin` without re-cloning or touching
 * branch/workload state. Same token → daemon no-ops. Public clone (no
 * credential) → null, nothing to rotate.
 */
export function gitCredentialRefreshPatch(
  opts: EnsureOptions,
): ConfigPatch | null {
  const cloneUrl = opts.repo?.cloneUrl;
  if (!cloneUrl || !cloneUrlHasCredentials(cloneUrl)) return null;
  return { git: { repository: { cloneUrl } } };
}
