import type { CmsMode } from "@decocms/shared/sdk/types";
import { isContentEditingEnabled } from "@/layouts/main-panel-tabs/content-editing-gate";

export type PreviewEditingMode = "preview" | "visual" | "blocks";

/** Leaving Visual returns to the Blocks split whenever that surface is enabled. */
export function toggleVisualEditingMode(
  current: PreviewEditingMode,
  blocksEditingEnabled: boolean,
): PreviewEditingMode {
  if (current !== "visual") return "visual";
  return blocksEditingEnabled ? "blocks" : "preview";
}

/**
 * A fresh Preview follows the same product gate as Content. When content
 * editing is enabled, desktop opens with Blocks. Mobile starts with the canvas
 * and can open Blocks over it; CMS `off` removes editing on every screen.
 */
export function defaultPreviewEditingMode(input: {
  /** The agent's CMS mode, already normalised by `resolveCmsMode`. */
  cmsMode: CmsMode;
  isMobile: boolean;
}): PreviewEditingMode {
  return isContentEditingEnabled(input.cmsMode) && !input.isMobile
    ? "blocks"
    : "preview";
}

/**
 * The editor mode Preview can render. Blocks uses the same agent-level product
 * gate as Content; the current display still decides whether Visual editing can inject into the iframe.
 */
export function resolveEffectivePreviewEditingMode(input: {
  editingMode: PreviewEditingMode;
  sandboxDisplay: boolean;
  blocksEditingEnabled: boolean;
}): PreviewEditingMode {
  if (input.editingMode === "blocks" && !input.blocksEditingEnabled) {
    return "preview";
  }
  if (input.editingMode === "visual" && !input.sandboxDisplay) return "preview";
  return input.editingMode;
}
