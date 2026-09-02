/** The layout tour's `data-tour` anchor names, in one place. STEP_DEFS and the
 *  components rendering the highlighted controls both read these constants, so
 *  a rename is a compile error rather than a step that silently vanishes — the
 *  tour runs with `skipMissingElement: true`, which would swallow it.
 *
 *  Anchors fall in two families, mirroring `StepScope` in `steps.ts`:
 *  the SHELL anchors are mounted on every workspace route, and the rest exist
 *  only where their surface does. A step is dropped unless BOTH its scope
 *  matches the current route and its anchor is actually on screen, so an anchor
 *  that renders conditionally is fine — it just has to render for the SAME
 *  cases its step claims. */
export const LAYOUT_TOUR_ANCHORS = {
  // ---- Shell: present on every workspace route.
  /** The org/agent picker at the top of the sidebar. */
  switcher: "tour-layout-switcher",
  /** The WHOLE sidebar (`SidebarShell`), not the destination list inside it:
   *  the step's point is that navigation now lives in one panel, which a
   *  spotlight around four rows does not make. */
  nav: "tour-layout-nav",
  /** The Tasks destination row. */
  tasks: "tour-layout-tasks",
  /** The account button at the foot of the sidebar. */
  account: "tour-layout-account",

  // ---- Org home.
  /** The org home's agents section. Deliberately mounted on BOTH the populated
   *  section and the empty state, because "you have no agents yet" is exactly
   *  when someone needs to be told where agents live and how to add one. Only
   *  one of the two renders at a time. */
  agents: "tour-layout-agents",
  /** The org home's activity column, absent when the board has no tasks. */
  recentActivity: "tour-layout-recent-activity",

  // ---- Project scope.
  /** The sidebar's Site Editor row. */
  siteEditor: "tour-layout-site-editor",
  /** The main panel's tab bar, which carries Preview / Content / Code. */
  surfaceTabs: "tour-layout-surface-tabs",
  /** The branch selector, wherever it is currently mounted. */
  branchPicker: "tour-layout-branch-picker",
  /** The sidebar's Automations row. */
  automations: "tour-layout-automations",
  /** The sidebar's Settings row. */
  settings: "tour-layout-settings",
} as const;

/** CSS attribute selector for a named anchor. */
export function layoutTourAnchorSelector(
  name: keyof typeof LAYOUT_TOUR_ANCHORS,
): string {
  return `[data-tour="${LAYOUT_TOUR_ANCHORS[name]}"]`;
}
