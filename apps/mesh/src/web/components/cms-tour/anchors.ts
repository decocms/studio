/**
 * Single source of truth for the CMS tour's `data-tour` anchor names.
 *
 * The tour (STEP_DEFS) and the components that render the highlighted controls
 * both reference these constants, so a rename is a compile error instead of a
 * step that silently vanishes (the tour runs with `skipMissingElement: true`).
 */
export const TOUR_ANCHORS = {
  /** The Preview tab in the header (produced generically as `tour-tab-preview`). */
  previewTab: "tour-tab-preview",
  /** The preview content root — readiness signal that the Preview view is live. */
  previewRoot: "tour-preview-root",
  dropdown: "tour-dropdown",
  edit: "tour-edit",
  visualEditor: "tour-visual-editor",
  device: "tour-device",
  branches: "tour-branches",
  submit: "tour-submit",
  publish: "tour-publish",
} as const;

/** CSS attribute selector for a named anchor. */
export function tourAnchorSelector(name: keyof typeof TOUR_ANCHORS): string {
  return `[data-tour="${TOUR_ANCHORS[name]}"]`;
}
