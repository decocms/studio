import type { MainSchemaAnswer } from "@/hooks/use-main-schema-v8";

/**
 * Which Experiments tab renders.
 *
 * - A Blocks (v8) site gets the tab that edits its `experiments` block in the
 *   draft (`v8`), whatever the org flags say: its A/B tests live in its
 *   content. `"error"` is a site last found v8 whose main can't be read right
 *   now; it opens as v8 too, as the Monitor tab does. While main's schema is
 *   still being read, the tab waits (`loading`) instead of flashing another
 *   one.
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
}): "v8" | "v2" | "legacy" | "loading" {
  if (input.siteMajor === "v8" || input.siteMajor === "error") return "v8";
  if (input.siteMajor === "loading") return "loading";
  return input.flagEnabled && input.ui !== "legacy" ? "v2" : "legacy";
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
  return orgEnabled || siteMajor === "v8" || siteMajor === "error";
}
