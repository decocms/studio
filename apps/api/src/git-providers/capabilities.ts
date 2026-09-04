/**
 * Which providers this deployment can connect through Studio-owned
 * credentials, without the caller reading an environment variable.
 *
 * The connect flows themselves are provider-specific by construction (a GitHub
 * App installation and a GitLab OAuth grant are different dances, and
 * `api/routes/git-providers.ts` implements both), but "can we offer this at
 * all" is one question with one shape per provider. Each provider answers for
 * itself; this is only the assembly, so no host or env var is named here.
 */

import type { GitProviderKind } from "@decocms/shared/git-providers";
import { githubCapability } from "./github/app-auth";
import { gitlabCapability } from "./gitlab/env";
import type { GitProviderCapability } from "./types";

export function providerCapabilities(): Record<
  GitProviderKind,
  GitProviderCapability
> {
  return { github: githubCapability(), gitlab: gitlabCapability() };
}
