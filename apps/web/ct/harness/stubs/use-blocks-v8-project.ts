/**
 * CT stub for `@/hooks/use-blocks-v8-project`.
 *
 * The real hook reads the project row through `useProjectContext()`, which
 * this harness doesn't mount. Field specs cover the editor as v7 sites see
 * it, so the "Blocks v8 site" switch reads as off here.
 */
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";

export function blocksV8Project(
  _project: VirtualMCPEntity | null | undefined,
): boolean {
  return false;
}

export function useBlocksV8Project(
  _virtualMcpId: string | null | undefined,
): boolean {
  return false;
}
