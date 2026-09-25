/**
 * Deployment config for Studio's GitHub App.
 *
 * All optional. With nothing set, the GitHub half of the git-providers routes
 * answers 503 and the legacy `mcp-github` paths keep working — the feature is
 * dormant until the operator registers the App, either with the environment
 * variables below (see `deploy/` and `selfhost/` docs) or in one click from the
 * admin dashboard (`stored-app-config.ts`). The environment wins when both are
 * present. Read through this helper only; tools never touch `process.env`.
 */

import {
  storedGithubAppConfig,
  storedGithubWebhookSecret,
} from "./stored-app-config";

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
  stored: GithubAppConfig | null = storedGithubAppConfig(),
): GithubAppConfig | null {
  return readGithubAppEnv(env) ?? stored;
}

/** Where this deployment's App comes from, for the admin dashboard. */
export function githubAppConfigSource(
  env: Record<string, string | undefined> = process.env,
  stored: GithubAppConfig | null = storedGithubAppConfig(),
): "env" | "stored" | null {
  if (readGithubAppEnv(env)) return "env";
  return stored ? "stored" : null;
}

function readGithubAppEnv(
  env: Record<string, string | undefined>,
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

/**
 * The secret GitHub signs webhook deliveries with. `GITHUB_WEBHOOK_SECRET`
 * wins; otherwise the dashboard-registered App's own secret, but only while
 * that App is the one in use — an env-configured App's deliveries are never
 * signed with it.
 */
export function readGithubWebhookSecret(
  env: Record<string, string | undefined> = process.env,
  stored: GithubAppConfig | null = storedGithubAppConfig(),
  storedSecret: string | null = storedGithubWebhookSecret(),
): string | null {
  const fromEnv = env.GITHUB_WEBHOOK_SECRET?.trim();
  if (fromEnv) return fromEnv;
  return githubAppConfigSource(env, stored) === "stored" ? storedSecret : null;
}
