import { useQueryClient } from "@tanstack/react-query";
import { neverPublishedBlock } from "./content-protocol-api";
import { useContentBackend } from "./use-content-backend";
import { protocolDecofileCacheKey } from "./use-decofile";

/**
 * Hosted v8: whether a block was never published, as the draft's changes
 * last read say (see {@link neverPublishedBlock}). Its deletion is no change
 * Publish lists, so the copy never offers Publish as the way back. Always
 * false on every other backend (their copy is unchanged).
 */
export function useNeverPublished(params: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}): (blockKey: string) => boolean {
  const queryClient = useQueryClient();
  const backend = useContentBackend(params.virtualMcpId, params.branch);
  if (backend.kind !== "protocol" || backend.source !== "github") {
    return () => false;
  }
  const cacheKey = protocolDecofileCacheKey(params, backend);
  return (blockKey) => neverPublishedBlock(queryClient, cacheKey, blockKey);
}
