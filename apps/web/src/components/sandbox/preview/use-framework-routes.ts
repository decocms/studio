import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import { buildSandboxUrl, type SandboxProxyRef } from "@/sdk/sandbox-url";
import {
  frameworkRouteRoots,
  frameworkRoutesFromFiles,
  type FrameworkRouteRoot,
} from "./framework-routes";

/** Enough for any real router tree; the daemon caps a glob at 10000. */
const ROUTE_GLOB_LIMIT = 5000;
const ROUTES_STALE_MS = 60_000;

async function listRouterFiles(
  ref: SandboxProxyRef,
  root: FrameworkRouteRoot,
): Promise<string[]> {
  const res = await fetch(buildSandboxUrl(ref, "glob"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pattern: root.pattern,
      path: root.dir,
      limit: ROUTE_GLOB_LIMIT,
    }),
  });
  if (!res.ok) throw new Error(`Failed to list ${root.dir}: ${res.status}`);
  const data = (await res.json()) as { files?: unknown };
  return Array.isArray(data.files)
    ? data.files.filter((file): file is string => typeof file === "string")
    : [];
}

/**
 * The static routes of the site's file-system router, read from the sandbox
 * working tree. Used by the page picker when the site has no deco pages.
 */
export function useFrameworkRoutes(
  ref: SandboxProxyRef | null,
  packagePath: string | null,
  enabled: boolean,
): string[] {
  const query = useQuery({
    queryKey: ref
      ? KEYS.frameworkRoutes(
          ref.orgSlug,
          ref.virtualMcpId,
          ref.branch,
          ref.threadId,
          packagePath,
        )
      : ["framework-routes", "none"],
    queryFn: async () => {
      if (!ref) return [];
      const roots = frameworkRouteRoots(packagePath);
      const listings = await Promise.all(
        roots.map(async (root) => ({
          root,
          files: await listRouterFiles(ref, root),
        })),
      );
      return frameworkRoutesFromFiles(listings);
    },
    enabled: enabled && !!ref,
    staleTime: ROUTES_STALE_MS,
  });
  return query.data ?? [];
}
