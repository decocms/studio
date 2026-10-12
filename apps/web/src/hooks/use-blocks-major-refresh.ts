/**
 * Keeps an open project's Blocks v8 marker current. The server runs
 * `isV8Schema` on main's `.deco/schema.gen.json` and writes the answer to
 * `metadata.blocksMajor` (`POST /api/:org/blocks-major/:id`); when that answer
 * differs from the project this page holds, the project is re-read, so a site
 * that upgraded to v8 (or went back to v7, or whose repository was seeded
 * after create) gets the right editor without a reload. Once per project per
 * session; projects without a repository make no request.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isBlocksV8Project } from "@decocms/shared/blocks-major";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext } from "@/sdk";
import { invalidateCollectionQueries } from "@/sdk/hooks/use-collections";

export function useBlocksMajorRefresh(
  project: VirtualMCPEntity | null | undefined,
): void {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const projectId = project?.id ?? "";
  const marked = isBlocksV8Project(project?.metadata);
  useQuery({
    queryKey: KEYS.blocksMajorRefresh(org.slug, projectId),
    queryFn: async (): Promise<boolean | null> => {
      const res = await fetch(
        `/api/${org.slug}/blocks-major/${encodeURIComponent(projectId)}`,
        { method: "POST", cache: "no-store" },
      );
      if (!res.ok) return null;
      const body = (await res.json().catch(() => null)) as {
        isV8?: unknown;
      } | null;
      const isV8 = typeof body?.isV8 === "boolean" ? body.isV8 : null;
      // The server just rewrote the marker: re-read the project.
      if (isV8 !== null && isV8 !== marked) {
        invalidateCollectionQueries(queryClient, org.id, "VIRTUAL_MCP");
      }
      return isV8;
    },
    enabled:
      !!org.id &&
      !!org.slug &&
      !!projectId &&
      agentHasClonableSource(project?.metadata),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}
