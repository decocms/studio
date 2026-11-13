import { useQueryClient } from "@tanstack/react-query";
import {
  contentBackendScopeKey,
  type ContentBackend,
  type ContentBackendIdentity,
} from "@/components/sections-editor/content-backend";
import type { DecofileScopeParams } from "@/components/sections-editor/content-write-keys";
import { KEYS } from "@/lib/query-keys";
import { protocolDecofileCacheKey } from "./cache-key";
import { useContentBackend } from "./use-content-backend";
import { useEnsureHostedBlocks, type HostedBlocksLoad } from "./hosted-content";

/** No editor may open from cached content while its backend is undecided. */
export function cmsBlocksLoadState(
  enabled: boolean,
  kind: ContentBackend["kind"],
  load: Pick<HostedBlocksLoad, "ready" | "failed">,
): Pick<HostedBlocksLoad, "ready" | "failed"> {
  if (!enabled) return { ready: true, failed: false };
  if (kind === "pending") return { ready: false, failed: false };
  if (kind === "unavailable") return { ready: false, failed: true };
  return load;
}

/** Keep mounted edits through outages, but never across storage destinations. */
export function cmsBlocksScopeKey(
  scope: DecofileScopeParams | null,
  backend: ContentBackendIdentity,
): string {
  return JSON.stringify([
    scope?.orgSlug,
    scope?.virtualMcpId,
    scope?.branch,
    contentBackendScopeKey(backend),
  ]);
}

/** A v8 hosted read. Other ready backends already hold complete bodies. */
export function useCmsBlocks(
  scope: DecofileScopeParams | null,
  names: readonly string[],
  options?: { withRefs?: boolean; listing?: Record<string, unknown> },
): HostedBlocksLoad & { scopeKey: string; v8: boolean } {
  const queryClient = useQueryClient();
  const backend = useContentBackend(scope?.virtualMcpId, scope?.branch);
  const hostedBackend =
    scope && backend.kind === "protocol" && backend.hosted ? backend : null;
  const load = useEnsureHostedBlocks(
    hostedBackend?.hosted,
    hostedBackend && scope
      ? protocolDecofileCacheKey(scope, hostedBackend)
      : "",
    names,
    options,
  );
  const state = cmsBlocksLoadState(scope !== null, backend.kind, load);
  return {
    ...state,
    v8: backend.kind !== "legacy",
    scopeKey: cmsBlocksScopeKey(scope, backend),
    retry: () => {
      load.retry();
      if (!scope || backend.kind !== "unavailable") return;
      const source = backend.source;
      void queryClient.resetQueries({
        queryKey: KEYS.contentBackend(
          scope.orgSlug,
          scope.virtualMcpId,
          ...(source === "local" ? ["local"] : [scope.branch, source]),
        ),
      });
    },
  };
}
