import type { MainSchemaAnswer } from "@/hooks/use-main-schema-v8";

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
 * - A Blocks (v8) site gets the tab that edits its `experiments` block in the
 *   draft (`v8`), whatever the org flags say: its A/B tests live in its
 *   content. `"error"` is a site last found v8 whose main can't be read right
 *   now; it opens as v8 too, as the Monitor tab does. While main's schema is
 *   still being read, a site the server last found v8 (`lastFoundV8`, its
 *   marker) waits (`loading`) instead of flashing another tab; any other
 *   site shows v7's choice at once, as before (a v8 site never marked shows
 *   it until its answer lands).
 * - Any other site keeps today's choice: the org's `experiments_v2_enabled`
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
  siteMajor: MainSchemaAnswer;
  ui: string | undefined;
  /** The server last found this site v8 (`useLastFoundV8`): a hint only. */
  lastFoundV8?: boolean;
}): "v8" | "v2" | "legacy" | "loading" {
  if (editsBlocksDraft(input.siteMajor)) return "v8";
  if (awaitsV8Answer(input.siteMajor, input.lastFoundV8)) return "loading";
  return v7ExperimentsTab(input.flagEnabled, input.ui);
}

/**
 * What the Experiments route shows: the tab (`pickExperimentsTab` picks
 * which), Settings where the tab isn't reachable, as before, or a wait while
 * main's schema is read on a site the server last found v8, which gets the
 * tab whatever the org's rollout says. Any other site never waits.
 */
export function experimentsRouteView(input: {
  orgEnabled: boolean;
  siteMajor: MainSchemaAnswer;
  lastFoundV8: boolean;
}): "tab" | "loading" | "settings" {
  if (experimentsTabVisible(input.orgEnabled, input.siteMajor)) return "tab";
  if (awaitsV8Answer(input.siteMajor, input.lastFoundV8)) return "loading";
  return "settings";
}

/**
 * Whether a view that has a v7 form waits for main's schema instead of
 * showing it: only on a site the server last found v8 (`lastFoundV8`), so a
 * v7 site shows its tab at once, as before. Calendar has no v7 form (a v7
 * site gets Settings), so it waits on every site while main is read.
 */
export function awaitsV8Answer(
  siteMajor: MainSchemaAnswer,
  lastFoundV8: boolean | undefined,
): boolean {
  return siteMajor === "loading" && !!lastFoundV8;
}

/**
 * Whether the Experiments tab is reachable: the org's rollout (flag, GA or
 * staff) as before, and every Blocks (v8) site, whose tests are content its
 * editors already own.
 */
export function experimentsTabVisible(
  orgEnabled: boolean,
  siteMajor: MainSchemaAnswer,
): boolean {
  return orgEnabled || editsBlocksDraft(siteMajor);
}

/**
 * Whether the site's tests and campaigns are edits to a Blocks (v8) draft:
 * the Calendar view exists, and Experiments and Calendar wear the site
 * editor's draft bar. "error" is a site last found v8, as above.
 */
export function editsBlocksDraft(siteMajor: MainSchemaAnswer): boolean {
  return siteMajor === "v8" || siteMajor === "error";
}
