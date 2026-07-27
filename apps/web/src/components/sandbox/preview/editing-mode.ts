export type PreviewEditingMode = "preview" | "visual" | "blocks";

export type PreviewEditorMode = Exclude<PreviewEditingMode, "preview">;

export function togglePreviewEditorMode(
  current: PreviewEditingMode,
  requested: PreviewEditorMode,
): PreviewEditingMode {
  return current === requested ? "preview" : requested;
}

/**
 * Whether the one-shot CMS auto-open should fire. All four must hold:
 * - `cmsDefaultOpen`: the per-agent Layout setting is on (off by default — this
 *   is the load-bearing safety gate),
 * - `blocksReady`: Blocks metadata resolved to renderable content,
 * - `!autoOpenResolved`: it hasn't already fired and the user hasn't taken
 *   manual control of the editing mode,
 * - `editingMode === "preview"`: the user isn't already in an editor.
 */
export function shouldAutoOpenCms(input: {
  cmsDefaultOpen: boolean;
  blocksReady: boolean;
  autoOpenResolved: boolean;
  editingMode: PreviewEditingMode;
}): boolean {
  return (
    input.cmsDefaultOpen &&
    input.blocksReady &&
    !input.autoOpenResolved &&
    input.editingMode === "preview"
  );
}
