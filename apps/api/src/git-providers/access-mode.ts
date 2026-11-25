/**
 * Who manages access to a linked repository on its provider.
 *
 * `managed`: the repository lives in an account the operator hosts for its
 * customers (see `readGithubManagedOwners`), where customers cannot administer
 * anything, so Studio invites people on their behalf. `self`: the repository's
 * owner administers it on the provider, and Studio only points there.
 */

import { splitOwnerName } from "@decocms/shared/git-providers";
import type { GitProviderAccountRecord } from "@/storage/git-provider-accounts";
import type { RepositoryRecord } from "@/storage/repositories";
import { readGithubManagedOwners } from "./github/env";

export type RepositoryAccessMode = "managed" | "self";

export function repositoryAccessMode(
  account: Pick<GitProviderAccountRecord, "type" | "authKind"> | null,
  repository: Pick<RepositoryRecord, "provider" | "path">,
  env: Record<string, string | undefined> = process.env,
): RepositoryAccessMode {
  if (
    repository.provider !== "github" ||
    account?.type !== "github" ||
    account.authKind !== "github_app"
  ) {
    return "self";
  }
  const { owner } = splitOwnerName(repository);
  return readGithubManagedOwners(env).has(owner.toLowerCase())
    ? "managed"
    : "self";
}
