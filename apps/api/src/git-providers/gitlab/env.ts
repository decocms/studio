/**
 * Deployment config for Studio's GitLab OAuth application.
 *
 * Optional, like its GitHub counterpart: unset, the GitLab half of the
 * git-providers routes answers 503 and an org connects with a token instead.
 * Read through this helper only; tools never touch `process.env`.
 */

import type { GitProviderCapability } from "../types";

export interface GitlabOAuthConfig {
  host: string;
  clientId: string;
  clientSecret: string;
}

/**
 * OAuth application for gitlab.com. Self-managed instances need their own
 * application registered per instance; those connect with a token for now.
 */
export function readGitlabOAuthConfig(
  env: Record<string, string | undefined> = process.env,
): GitlabOAuthConfig | null {
  const clientId = env.GITLAB_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GITLAB_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return {
    host: (env.GITLAB_OAUTH_HOST?.trim() || "gitlab.com").toLowerCase(),
    clientId,
    clientSecret,
  };
}

export function gitlabCapability(): GitProviderCapability {
  const config = readGitlabOAuthConfig();
  return { configured: config !== null, hosts: config ? [config.host] : [] };
}
