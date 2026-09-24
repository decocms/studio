/**
 * Re-mints the two short-lived credentials a sandbox's persisted options
 * embed. Shared by the in-process runner (autonomous recovery) and the sandbox
 * controller's callbacks, which need Studio's database and vault to mint.
 */

import type { Kysely } from "kysely";
import type { EnsureRepo } from "@decocms/sandbox/provider";
import { auth } from "@/auth";
import { getPublicUrl } from "@/core/server-constants";
import type { CredentialVault } from "@/encryption/credential-vault";
import { mintOrgFsConfigJson } from "@/file-storage/mount/provisioning";
import { cloneInfoForRepository } from "@/git-providers";
import { parseGithubOwnerRepo } from "@/sandbox/parse-github-clone-url";
import { buildCloneInfo } from "@/shared/github-clone-info";
import { OrgRepoSyncStorage } from "@/storage/org-repo-syncs";
import { RepositoryStorage } from "@/storage/repositories";
import type { Database as DatabaseSchema } from "@/storage/types";

export interface SandboxTenant {
  orgId: string;
  userId: string;
  orgSlug?: string;
}

export function sandboxCredentialMinters(
  db: Kysely<DatabaseSchema>,
  vault: CredentialVault,
) {
  return {
    mintCloneUrl: async (
      repo: Pick<EnsureRepo, "cloneUrl" | "connectionId" | "repositoryId">,
      mintOpts?: { bufferMs?: number },
    ): Promise<string | null> => {
      // First-class repositories re-mint through their provider account.
      if (repo.repositoryId) {
        const repository = await new RepositoryStorage(db).getUnscoped(
          repo.repositoryId,
        );
        if (!repository) return null;
        const { cloneUrl } = await cloneInfoForRepository(
          { db, vault },
          repository,
          { bufferMs: mintOpts?.bufferMs },
        );
        return cloneUrl;
      }
      // Only connection-backed clones can be re-minted; buildCloneInfo
      // refreshes standard OAuth GitHub connections from db + vault alone.
      // Legacy repo-scoped tokens throw here (need an org-scoped ctx) and
      // the runner falls back to the persisted URL.
      if (!repo.connectionId) return null;
      const parsed = parseGithubOwnerRepo(repo.cloneUrl);
      if (!parsed) return null;
      const { cloneUrl } = await buildCloneInfo(
        repo.connectionId,
        parsed.owner,
        parsed.name,
        db,
        vault,
        { bufferMs: mintOpts?.bufferMs },
      );
      return cloneUrl;
    },
    // Same lifetime problem as mintCloneUrl; see mintOrgFsConfig's docs.
    mintOrgFsConfig: async (tenant: SandboxTenant): Promise<string | null> => {
      if (!tenant.orgSlug) return null;
      const json = await mintOrgFsConfigJson(
        {
          boundAuth: {
            apiKey: {
              create: (data) =>
                auth.api.createApiKey({
                  body: { ...data, userId: tenant.userId },
                }),
            },
          },
          storage: { orgRepoSyncs: new OrgRepoSyncStorage(db) },
        },
        {
          orgSlug: tenant.orgSlug,
          orgId: tenant.orgId,
          baseUrl: getPublicUrl(),
        },
      );
      return json ?? null;
    },
  };
}
