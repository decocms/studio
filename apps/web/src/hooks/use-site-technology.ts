import {
  siteTechnologyFromFramework,
  siteTechnologyFromPackageManager,
  type SiteTechnology,
} from "@decocms/shared/site-apps";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import { useVirtualMCP } from "@/sdk";

/**
 * Which deco stack the project is built on.
 *
 * The site's own `/live/_meta` answers first: the CMS already holds it in both
 * runtimes, and it describes what is actually deployed.
 * `metadata.runtime.selected` is only the tiebreak, because it is a picker
 * value — a freshly imported repo has none until its first sandbox start, and
 * gating on it alone silently empties every catalogue built from this.
 *
 * Null when neither answers, so a caller offers nothing rather than the wrong
 * stack. Suspense-backed and requires ProjectContext (via `useVirtualMCP`),
 * like `usePackagePath` — resolve it where both exist and thread the plain
 * value into leaf hooks.
 */
export function useSiteTechnology(
  virtualMcpId: string | undefined,
  meta: LiveMeta | undefined,
): SiteTechnology | null {
  const selected = useVirtualMCP(virtualMcpId)?.metadata?.runtime?.selected;
  return (
    (meta ? siteTechnologyFromFramework(meta.framework) : null) ??
    siteTechnologyFromPackageManager(selected)
  );
}
