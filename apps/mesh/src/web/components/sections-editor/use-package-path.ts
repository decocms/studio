import { useVirtualMCP } from "@decocms/mesh-sdk";

/**
 * The project's package path (`metadata.runtime.path`, e.g.
 * "eitri-shopping-monte-carlo-shared"), or null when the project lives at the
 * repo root. Pair with {@link decoRepoPath} to address `.deco/*` files through
 * the sandbox daemon, which resolves paths against the repo root.
 *
 * Suspense-backed and requires ProjectContext (via `useVirtualMCP`), so resolve
 * it in a component/hook that has both and thread the plain string into leaf
 * data hooks/mutations — keeping those free of that coupling.
 */
export function usePackagePath(
  virtualMcpId: string | undefined,
): string | null {
  return useVirtualMCP(virtualMcpId)?.metadata?.runtime?.path ?? null;
}
