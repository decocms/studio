/**
 * Which Experiments tab renders: the org's `experiments_v2_enabled` flag, with
 * `?ui=legacy` able to preview the old one for the current visit.
 *
 * The override only ever moves BACKWARD. `assertExperimentsV2` gates the
 * rebuilt tools on the org flag, so a URL that forced the new tab forward would
 * render a screen whose agent actions the server rejects.
 *
 * Its own module so the choice is unit-testable without pulling the tab's
 * component graph into the test runtime.
 */
export function pickExperimentsTab(
  flagEnabled: boolean,
  ui: string | undefined,
): "v2" | "legacy" {
  return flagEnabled && ui !== "legacy" ? "v2" : "legacy";
}
