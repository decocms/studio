import type { RepositoryBinding } from "@decocms/shared/sdk";
import { repositoryBindingRef } from "@decocms/shared/repository-binding";
import type { GitProviderStoragePorts } from "./credentials";
import type { RepositoryRecord } from "@/storage/repositories";

/** Resolve a binding in its organization without assuming a provider host. */
export async function findRepositoryForBinding(
  storage: Pick<GitProviderStoragePorts, "repositories">,
  organizationId: string,
  binding: Pick<RepositoryBinding, "url" | "repositoryId">,
): Promise<RepositoryRecord | null> {
  if (binding.repositoryId)
    return storage.repositories.get(binding.repositoryId, organizationId);
  const ref = repositoryBindingRef(binding);
  return ref ? storage.repositories.findByRef(organizationId, ref) : null;
}
