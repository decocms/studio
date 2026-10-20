import { useQueryClient } from "@tanstack/react-query";
import type { ContentSyncTarget } from "./content-sync";
import { useContentBackend } from "./use-content-backend";
import { useDecofileCacheKey } from "./use-decofile";

/** The editor's content-sync target for one project and draft (content-sync.ts). */
export function useContentSyncTarget(params: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string | null;
}): ContentSyncTarget {
  const queryClient = useQueryClient();
  const { orgSlug, virtualMcpId, branch } = params;
  const backend = useContentBackend(virtualMcpId, branch);
  const cacheKey = useDecofileCacheKey(
    branch ? { orgSlug, virtualMcpId, branch } : null,
  );
  return {
    queryClient,
    orgSlug,
    virtualMcpId,
    branch,
    backend,
    cacheKey: cacheKey || null,
  };
}
