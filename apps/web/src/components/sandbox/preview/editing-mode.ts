import type { CmsMode } from "@decocms/shared/sdk/types";
import { isContentEditingEnabled } from "@/layouts/main-panel-tabs/content-editing-gate";

export type PreviewEditingMode = "preview" | "visual" | "blocks";

/** Blocks is a desktop editing surface. Content remains available on mobile. */
export function isBlocksEditingEnabled(input: {
  contentEditingEnabled: boolean;
  isMobile: boolean;
}): boolean {
  return input.contentEditingEnabled && !input.isMobile;
}

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
 * editing is enabled, Blocks is part of the desktop Site Editor surface rather
 * than an opt-in toolbar mode. Mobile and `off` keep the plain preview.
 */
export function defaultPreviewEditingMode(input: {
  /** The agent's CMS mode, already normalised by `resolveCmsMode`. */
  cmsMode: CmsMode;
  isMobile: boolean;
}): PreviewEditingMode {
  return isBlocksEditingEnabled({
    contentEditingEnabled: isContentEditingEnabled(input.cmsMode),
    isMobile: input.isMobile,
  })
    ? "blocks"
    : "preview";
}

/**
 * The editor mode Preview can render. Blocks uses the same agent-level product
 * gate as Content plus its desktop-only layout constraint; the current display
 * still decides whether Visual editing can inject into the iframe.
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
