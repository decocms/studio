/** v7's choice, as main shipped it: the org flag, `?ui=legacy` backward only. */
function v7ExperimentsTab(
  flagEnabled: boolean,
  ui: string | undefined,
): "v2" | "legacy" {
  return flagEnabled && ui !== "legacy" ? "v2" : "legacy";
}

/**
 * Which Experiments tab renders.
 *
 * - A Blocks v8 project (its "Blocks v8 site" switch on) gets the tab that
 *   edits its `experiments` block in the draft (`v8`), whatever the org flags
 *   say: its A/B tests live in its content.
 * - Any other project keeps main's choice: the org's `experiments_v2_enabled`
 *   flag, with `?ui=legacy` able to preview the old tab for the current
 *   visit. That override only ever moves BACKWARD: `assertExperimentsV2`
 *   gates the rebuilt tools on the org flag, so a URL that forced the new tab
 *   forward would render a screen whose agent actions the server rejects.
 *
 * Its own module so the choice is unit-testable without pulling the tab's
 * component graph into the test runtime.
 */
export function pickExperimentsTab(input: {
  flagEnabled: boolean;
  /** The project's "Blocks v8 site" switch (`useBlocksV8Project`). */
  v8: boolean;
  ui: string | undefined;
}): "v8" | "v2" | "legacy" {
  if (input.v8) return "v8";
  return v7ExperimentsTab(input.flagEnabled, input.ui);
}

/**
 * Whether the Experiments tab is reachable: the org's rollout (flag, GA or
 * staff) as on main, and every Blocks v8 project, whose tests are content its
 * editors already own. Where it isn't, the route shows Settings, as on main.
 */
export function experimentsTabVisible(
  orgEnabled: boolean,
  v8: boolean,
): boolean {
  return orgEnabled || v8;
}
