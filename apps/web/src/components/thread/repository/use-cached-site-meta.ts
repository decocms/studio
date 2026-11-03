import { useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema.ts";
import { KEYS } from "@/lib/query-keys";

/**
 * The site schema the editor last read for this branch, from any of its
 * sources (`useLiveMeta` keys them all under one prefix), with no request of
 * its own: the schema is about 1 MB. `undefined` until the editor has read it.
 */
export function useCachedSiteMeta(scope: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}): LiveMeta | undefined {
  const queryCache = useQueryClient().getQueryCache();
  const read = () => {
    let newest: { data: LiveMeta; at: number } | undefined;
    for (const query of queryCache.findAll({
      queryKey: KEYS.liveMeta(scope.orgSlug, scope.virtualMcpId, scope.branch),
    })) {
      const { data, dataUpdatedAt } = query.state;
      if (data && (!newest || dataUpdatedAt > newest.at)) {
        newest = { data: data as LiveMeta, at: dataUpdatedAt };
      }
    }
    return newest?.data;
  };
  return useSyncExternalStore(
    (onChange) => queryCache.subscribe(onChange),
    read,
  );
}
