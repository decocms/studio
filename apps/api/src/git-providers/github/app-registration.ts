/**
 * The deployment's GitHub App registration, as the admin dashboard sees it.
 * Re-exported through the `git-providers` barrel so the admin routes don't
 * reach into `github/`.
 */

import { getGithubAppAuth } from "./app-auth";
import { githubAppConfigSource } from "./env";
import {
  storedGithubAppInfo,
  type StoredGithubAppInfo,
} from "./stored-app-config";

export interface GithubAppRegistrationStatus {
  /** Where the App comes from: environment variables win over a stored one. */
  source: "env" | "stored" | null;
  /** Config present AND its key can sign — a bad PEM is not "configured". */
  usable: boolean;
  /** The App registered from the dashboard, if any (even when env wins). */
  stored: StoredGithubAppInfo | null;
}

export async function githubAppRegistrationStatus(): Promise<GithubAppRegistrationStatus> {
  const source = githubAppConfigSource();
  const stored = await storedGithubAppInfo().catch(() => null);
  return {
    source,
    usable: source !== null && getGithubAppAuth() !== null,
    stored,
  };
}
