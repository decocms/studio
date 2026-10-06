/**
 * CT stub for `sections-editor/use-content-backend`.
 *
 * The real hook picks a project's content backend from the org flag, the
 * project's `deco serve` connection and a probe of its schema, all through
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
