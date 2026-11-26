/**
 * Whether a repository an organization linked can be read right now, in terms
 * of what a human has to do about it.
 *
 * The distinction a consumer needs is DURABLE versus TRANSIENT: only a durable
 * answer may tell a reader to reconnect. `auth_failed` is durable (the grant is
 * dead until someone reconnects); a provider 5xx or rate limit never becomes a
 * reason, because it is raised rather than reported.
 */

import type { RepoRef } from "@decocms/shared/git-providers";
import type { StudioContext } from "@/core/studio-context";
import {
  type RepositoryRecord,
  type RepositoryStorage,
  repoRefOf,
} from "@/storage/repositories";
import { providerCapabilities } from "./capabilities";
import { accountIsServable, clientForAccount } from "./credentials";
import { GitProviderError } from "./types";

export type RepositoryUnusableReason =
  | "no_account"
  | "account_revoked"
  | "provider_unconfigured"
  | "auth_failed"
  | "not_found";

export type RepositoryUsability =
  | { usable: true; reason: "ok" }
  | { usable: false; reason: RepositoryUnusableReason };

/**
 * The live call is the point: a stored account row says nothing about whether
 * its grant was revoked on the provider's side this morning.
 */
export async function repositoryUsability(
  ctx: Pick<StudioContext, "storage" | "db" | "vault">,
  repository: RepositoryRecord,
): Promise<RepositoryUsability> {
  if (!repository.accountId) {
    return { usable: false, reason: "no_account" };
  }
  const account = await ctx.storage.gitProviderAccounts.get(
    repository.accountId,
    repository.organizationId,
  );
  if (!account) return { usable: false, reason: "no_account" };
  if (account.status !== "active") {
    return { usable: false, reason: "account_revoked" };
  }
  if (!accountIsServable(account)) {
    return {
      usable: false,
      reason: providerCapabilities()[account.type].configured
        ? "account_revoked"
        : "provider_unconfigured",
    };
  }
  try {
    const summary = await clientForAccount(ctx, account).getRepo(
      repoRefOf(repository),
    );
    return summary
      ? { usable: true, reason: "ok" }
      : { usable: false, reason: "not_found" };
  } catch (error) {
    // A 403 with a wait is a rate limit, which is transient.
    if (
      error instanceof GitProviderError &&
      error.isAuthFailure &&
      !error.isRateLimited
    ) {
      return { usable: false, reason: "auth_failed" };
    }
    throw error;
  }
}

/**
 * The org's repository for an identity. `findByRef` matches on host and path
 * alone, so the provider is checked here: two providers can share a host in a
 * self-managed deployment, and answering with the wrong one would credential a
 * read against a repository the caller did not name.
 */
export async function findLinkedRepository(
  repositories: Pick<RepositoryStorage, "findByRef">,
  organizationId: string,
  ref: RepoRef,
): Promise<RepositoryRecord | null> {
  const repository = await repositories.findByRef(organizationId, {
    host: ref.host,
    path: ref.path,
  });
  return repository?.provider === ref.provider ? repository : null;
}
