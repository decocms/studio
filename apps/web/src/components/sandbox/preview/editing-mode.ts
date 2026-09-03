import type { ThreadRuntime } from "@decocms/shared/thread/session-runtime";
import type { CmsMode } from "@decocms/shared/sdk/types";

export type PreviewEditingMode = "preview" | "visual" | "blocks";

export type PreviewEditorMode = Exclude<PreviewEditingMode, "preview">;

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
 * A CMS session has no working tree and nothing to code: editing blocks beside
 * the frame is what the Site Editor IS there, so Preview opens with the blocks
 * editor already split in rather than behind a control the user has to find. A
 * sandbox session opens on the plain preview, and `off` — an agent with no CMS
 * at all — keeps every session there.
 */
export function defaultPreviewEditingMode(input: {
  /** THIS session's runtime, read from the thread's own stamp. */
  runtime: ThreadRuntime;
  /** The agent's CMS mode, already normalised by `resolveCmsMode`. */
  cmsMode: CmsMode;
}): PreviewEditingMode {
  return input.runtime === "cms" && input.cmsMode !== "off"
    ? "blocks"
    : "preview";
}
