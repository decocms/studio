/**
 * CT stub for `sections-editor/use-content-backend`.
 *
 * The real hook waits for a schema for its mode (main's, from the server; a
 * sandbox's working tree; a `deco serve`'s) and probes its backend, all through
 * `useProjectContext()`, which this harness doesn't mount. Field specs cover
 * the editor as v7 sites see it, so every project reads as legacy here.
 */
import type { ContentBackend } from "@/components/sections-editor/content-backend";

export function useContentBackend(
  _virtualMcpId: string | null | undefined,
  _branch: string | null | undefined,
): ContentBackend {
  return { kind: "legacy" };
}
