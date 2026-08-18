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

/**
 * The editing mode the preview can actually honour right now.
 *
 * Two requests get downgraded to plain preview:
 * - `visual` without the live sandbox iframe — the production fallback is a
 *   different origin we cannot inject into.
 * - `blocks` on a CMS project — its block editor lives in the SIDE PANEL, so
 *   the inline pane would be a second copy of the same editor with its own
 *   selection state.
 *
 * `cmsCapable` is deliberately the project-level gate, not the per-branch one:
 * the side panel owns content editing in both CMS and vibecoding mode, so
 * provisioning a sandbox must not resurrect the inline pane. Projects with no
 * CMS keep it as their only way in.
 *
 * `blocks` otherwise survives a sandbox restart, so its loading/error state
 * stays actionable and the panel keeps reading the committed snapshot.
 */
export function resolveEffectiveEditingMode(input: {
  editingMode: PreviewEditingMode;
  /** The preview is showing the live sandbox iframe (not a fallback origin). */
  sandboxDisplay: boolean;
  /** The project has a CMS, so the side panel owns block editing. */
  cmsCapable: boolean;
}): PreviewEditingMode {
  if (input.editingMode === "visual" && !input.sandboxDisplay) return "preview";
  if (input.editingMode === "blocks" && input.cmsCapable) return "preview";
  return input.editingMode;
}
