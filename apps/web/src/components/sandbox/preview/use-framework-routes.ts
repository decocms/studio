import { useQuery } from "@tanstack/react-query";
import { readCommittedJson } from "@/components/sections-editor/read-committed-file";
import { KEYS } from "@/lib/query-keys";
import { buildSandboxUrl, type SandboxProxyRef } from "@/sdk/sandbox-url";
import {
  detectRouterFramework,
  frameworkRouteRoots,
  frameworkRoutesFromFiles,
  packageRepoPath,
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

async function readFrameworkRoutes(
  ref: SandboxProxyRef,
  packagePath: string | null,
): Promise<string[]> {
  const pkg = await readCommittedJson<unknown>(
    ref,
    packageRepoPath(packagePath, "package.json"),
  );
  if (pkg.kind === "unavailable") {
    throw new Error("package.json unavailable: sandbox not ready");
  }
  const framework =
    pkg.kind === "data" ? detectRouterFramework(pkg.data) : null;
  if (!framework) return [];
  const roots = frameworkRouteRoots(framework, packagePath);
  const listings = await Promise.all(
    roots.map(async (root) => ({
      root,
      files: await listRouterFiles(ref, root),
    })),
  );
  return frameworkRoutesFromFiles(listings);
}

/**
 * The static routes of the site's file-system router (Next.js or TanStack
 * Router, per its `package.json`), read from the sandbox working tree.
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
    queryFn: () => (ref ? readFrameworkRoutes(ref, packagePath) : []),
    enabled: enabled && !!ref,
    staleTime: ROUTES_STALE_MS,
  });
  return query.data ?? [];
}
