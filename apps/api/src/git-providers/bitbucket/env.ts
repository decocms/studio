/**
 * Deployment config for Studio's Bitbucket Cloud OAuth consumer.
 *
 * Optional, like its GitHub and GitLab counterparts: unset, the Bitbucket
 * half of the git-providers routes answers 503 and an org connects with an
 * access token instead. Read through this helper only; tools never touch
 * `process.env`.
 *
 * Bitbucket Cloud has one host, so there is no `*_HOST` variable: the OAuth
 * consumer is registered on bitbucket.org and nowhere else. Bitbucket Data
 * Center is a different product with a different API and is not served here.
 */

import { DEFAULT_HOSTS } from "@decocms/shared/git-providers";
import type { GitProviderCapability } from "../types";

export const BITBUCKET_HOST = DEFAULT_HOSTS.bitbucket;

export interface BitbucketOAuthConfig {
  host: string;
  /** Atlassian calls this the consumer "Key". */
  clientId: string;
  clientSecret: string;
}

export function readBitbucketOAuthConfig(
  env: Record<string, string | undefined> = process.env,
): BitbucketOAuthConfig | null {
  const clientId = env.BITBUCKET_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.BITBUCKET_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { host: BITBUCKET_HOST, clientId, clientSecret };
}

export function bitbucketCapability(): GitProviderCapability {
  const config = readBitbucketOAuthConfig();
  return { configured: config !== null, hosts: config ? [config.host] : [] };
}
