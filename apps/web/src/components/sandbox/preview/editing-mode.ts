import type { ThreadRuntime } from "@decocms/shared/thread/session-runtime";
import type { CmsMode } from "@decocms/shared/sdk/types";
import { isContentEditingEnabled } from "@/layouts/main-panel-tabs/content-editing-gate";

export type PreviewEditingMode = "preview" | "visual" | "blocks";

export type PreviewEditorMode = Exclude<PreviewEditingMode, "preview">;

/** Blocks is a desktop editing surface. Content remains available on mobile. */
export function isBlocksEditingEnabled(input: {
  contentEditingEnabled: boolean;
  isMobile: boolean;
}): boolean {
  return input.contentEditingEnabled && !input.isMobile;
}

export function togglePreviewEditorMode(
  current: PreviewEditingMode,
  requested: PreviewEditorMode,
): PreviewEditingMode {
  return current === requested ? "preview" : requested;
}

/**
 * The editing mode a fresh Preview opens in — derived from the SESSION, never
 * from a per-agent auto-open flag.
 *
 * A desktop CMS session has no working tree and nothing to code: editing blocks
 * beside the frame is what the Site Editor IS there, so Preview opens with the
 * blocks editor already split in rather than behind a control the user has to
 * find. Mobile and sandbox sessions open on the plain preview, and `off` — an
 * agent with no CMS at all — keeps every session there.
 */
export function defaultPreviewEditingMode(input: {
  /** THIS session's runtime, read from the thread's own stamp. */
  runtime: ThreadRuntime;
  /** The agent's CMS mode, already normalised by `resolveCmsMode`. */
  cmsMode: CmsMode;
  isMobile: boolean;
}): PreviewEditingMode {
  return input.runtime === "cms" &&
    isBlocksEditingEnabled({
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
