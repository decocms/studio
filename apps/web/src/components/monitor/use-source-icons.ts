/**
 * The icon of each source the Monitor reads: the connection's own when one is
 * connected, else the app's icon in the deco registry (the same one the
 * connect-sources cards show), else a bundled logo. One registry read per
 * org, never blocking the page: until it lands, the bundled logos show.
 */

import { useQuery } from "@tanstack/react-query";
import {
  buildRegistryWhere,
  type RegistryItemLike,
  unwrapToolResult,
} from "@/routes/reports-onboarding/companions-core";
import { KEYS } from "@/lib/query-keys";
import { callStudioTool } from "@/lib/studio-tools";
import type { SourceId, SourceRow } from "./board";

const REGISTRY_APP: Record<SourceId, string | null> = {
  orders: "deco/vtex",
  site: null,
  deploys: "deco/github-mcp",
  analytics: "deco/google-analytics",
  search: "deco/google-search-console",
};

const BUNDLED: Record<SourceId, string | null> = {
  orders: "https://raw.githubusercontent.com/deco-cx/apps/main/vtex/logo.png",
  site: "/favicon.svg",
  deploys: "/connections/github.png",
  analytics: null,
  search: null,
};

const registryIcon = (item: RegistryItemLike | undefined) =>
  item?.server?.icons?.[0]?.src ?? null;

export function useSourceIcons(
  orgSlug: string,
  sources: readonly SourceRow[],
): (id: SourceId) => string | null {
  const ids = Object.values(REGISTRY_APP).filter(
    (id): id is string => id !== null,
  );
  const registry = useQuery({
    queryKey: KEYS.monitorSourceIcons(orgSlug),
    queryFn: async () => {
      const where = buildRegistryWhere(ids, []);
      const result = await callStudioTool(
        orgSlug,
        "COLLECTION_REGISTRY_APP_LIST",
        { ...(where ? { where } : {}), limit: ids.length },
      );
      return unwrapToolResult<{ items: RegistryItemLike[] }>(result).items;
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const byId = new Map((registry.data ?? []).map((item) => [item.id, item]));
  return (id) => {
    const own = sources.find((s) => s.id === id)?.icon;
    const app = REGISTRY_APP[id];
    return own ?? registryIcon(app ? byId.get(app) : undefined) ?? BUNDLED[id];
  };
}
