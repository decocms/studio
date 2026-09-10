import type { VirtualMcpUILayout } from "@decocms/shared/sdk/types";

type PersistedVirtualMcpLayout = VirtualMcpUILayout & Record<string, unknown>;

/**
 * Apply the focused pinned-views tool's optional layout patch without erasing
 * settings it does not own. Stored metadata is loose and may contain fields
 * added by newer deployments, so merge the raw object rather than rebuilding
 * it from the patch's known keys.
 *
 * An omitted patch is a true no-op for an existing layout object. If stored
 * metadata is not an object, normalize it to null when there is no patch and
 * start from an empty object when there is one; arrays and primitives must
 * never be spread into a layout.
 */
export function mergeVirtualMcpLayout(
  currentLayout: unknown,
  layoutPatch: VirtualMcpUILayout | undefined,
): PersistedVirtualMcpLayout | null {
  const currentRecord =
    currentLayout !== null &&
    typeof currentLayout === "object" &&
    !Array.isArray(currentLayout)
      ? (currentLayout as Record<string, unknown>)
      : null;

  if (layoutPatch === undefined) {
    // The storage boundary types valid persisted objects as VirtualMcpUILayout,
    // while the record shape keeps forward-compatible unknown keys intact.
    return currentRecord as PersistedVirtualMcpLayout | null;
  }

  return { ...(currentRecord ?? {}), ...layoutPatch };
}
