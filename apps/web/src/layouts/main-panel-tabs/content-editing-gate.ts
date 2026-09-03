import type { CmsMode } from "@decocms/shared/sdk/types";

/**
 * The one product gate for Studio's two content-editing surfaces: the Content
 * panel and the Blocks form beside Preview. Capability reads belong inside the
 * surfaces, where they can render loading, setup, and error states; they must
 * not make either entry point appear late or disappear on a transient failure.
 */
export function isContentEditingEnabled(cmsMode: CmsMode): boolean {
  return cmsMode !== "off";
}
