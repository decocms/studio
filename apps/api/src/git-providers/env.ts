/**
 * Deployment config for Studio-owned git provider credentials.
 *
 * All optional. With nothing set, the git-providers routes answer 503 and the
 * legacy `mcp-github` paths keep working — the feature is dormant until the
 * operator registers the apps (see `deploy/` and `selfhost/` docs).
 *
 * Read through these helpers only; tools never touch `process.env`.
 */

export interface GithubAppConfig {
  appId: string;
  /** PEM. `\n` escape sequences are accepted for single-line env values. */
  privateKeyPem: string;
  clientId: string;
  clientSecret: string;
  /** App slug, for `https://github.com/apps/<slug>/installations/new`. */
  slug: string;
}

export function readGithubAppConfig(
  env: Record<string, string | undefined> = process.env,
): GithubAppConfig | null {
  const appId = env.GITHUB_APP_ID?.trim();
  const privateKey = env.GITHUB_APP_PRIVATE_KEY?.trim();
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim();
  const slug = env.GITHUB_APP_SLUG?.trim();
  if (!appId || !privateKey || !clientId || !clientSecret || !slug) return null;
  return {
    appId,
    privateKeyPem: privateKey.replace(/\\n/g, "\n"),
    clientId,
    clientSecret,
    slug,
  };
}

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
