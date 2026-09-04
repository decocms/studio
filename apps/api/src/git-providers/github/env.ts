/**
 * Deployment config for Studio's GitHub App.
 *
 * All optional. With nothing set, the GitHub half of the git-providers routes
 * answers 503 and the legacy `mcp-github` paths keep working — the feature is
 * dormant until the operator registers the App (see `deploy/` and `selfhost/`
 * docs). Read through this helper only; tools never touch `process.env`.
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
