import { useVirtualMCP } from "@/sdk";
import { resolveFastPreview } from "@/sdk/fast-preview";
import { useActiveThreadMeta } from "./use-active-thread-meta";

/**
 * The Fast Preview gate for the CURRENT session, read the one correct way.
 *
 * Every CMS surface was repeating the same three-step dance — resolve the vMCP
 * entity, resolve the active thread's runtime stamp, feed both to
 * `resolveFastPreview` — and a surface that forgot the second argument silently
 * disagreed with the rest (a coding session would have been treated as
 * sandbox-less). Collapsing it here makes that class of drift unrepresentable.
 *
 * `previewServerUrl` is returned alongside `active` because the callers that
 * need one almost always need the other: it is the origin a sandbox-less
 * session renders against.
 */
export function useFastPreview(virtualMcpId: string | null | undefined): {
  previewServerUrl: string | null;
  active: boolean;
} {
  return resolveFastPreview(
    useVirtualMCP(virtualMcpId ?? undefined)?.metadata,
    useActiveThreadMeta(),
  );
}
