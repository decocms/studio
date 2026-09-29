import { repoRefFromOwnerName } from "@decocms/shared/git-providers";
import type { RepositoryRecord } from "@/storage/repositories";
import type { GitProviderStoragePorts } from "./credentials";

export async function findRepositoryForBinding(
  storage: Pick<GitProviderStoragePorts, "repositories">,
  organizationId: string,
  binding: { owner: string; name: string; repositoryId?: string | null },
): Promise<RepositoryRecord | null> {
  if (binding.repositoryId) {
    const byId = await storage.repositories.get(
      binding.repositoryId,
      organizationId,
    );
    if (byId) return byId;
  }
  return storage.repositories.findByRef(
    organizationId,
    repoRefFromOwnerName(binding.owner, binding.name),
  );
}
