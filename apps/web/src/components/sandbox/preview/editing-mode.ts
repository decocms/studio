export type PreviewEditingMode = "preview" | "visual" | "blocks";

export type PreviewEditorMode = Exclude<PreviewEditingMode, "preview">;

export function togglePreviewEditorMode(
  current: PreviewEditingMode,
  requested: PreviewEditorMode,
): PreviewEditingMode {
  return current === requested ? "preview" : requested;
}
