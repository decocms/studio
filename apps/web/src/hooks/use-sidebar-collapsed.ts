/** Is the sidebar showing its ICON RAIL right now?
 *
 *  Not the same question as `state === "collapsed"`. On mobile the sidebar is a
 *  sheet: it opens at full width regardless of the persisted desktop state, so
 *  a collapsed `state` there still paints labels. Every caller that wants "are
 *  we down to icons" — tooltips, rail-only affordances — wants both halves, and
 *  the halves were drifting apart across the sidebar files.
 */

import { useSidebar } from "@decocms/ui/components/sidebar.tsx";

export function useSidebarCollapsed(): boolean {
  const { state, isMobile } = useSidebar();
  return state === "collapsed" && !isMobile;
}
