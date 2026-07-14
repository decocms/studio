export type PreviewSurface = "preview" | "blocks";
export type PreviewInteractiveViewMode = "preview" | "visual";
export type PreviewViewMode = PreviewInteractiveViewMode | "cms";

export function viewModeForSurface(
  surface: PreviewSurface,
  interactiveViewMode: PreviewInteractiveViewMode,
): PreviewViewMode {
  return surface === "blocks" ? "cms" : interactiveViewMode;
}

export function canToggleVisualEditor(surface: PreviewSurface): boolean {
  return surface === "preview";
}
