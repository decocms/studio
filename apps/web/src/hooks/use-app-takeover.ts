/**
 * Whether the route showing is an APP rather than a place in the product.
 *
 * A project is not a scope you enter — it is a screen, and the tiles on it
 * LAUNCH things. Something launched takes the screen: the sidebar is how you
 * move between places, and a tool is not a place, so leaving the nav up beside
 * it says you are still browsing when you are working.
 *
 * The breadcrumb stays and is the way back — the project's own crumb is already
 * the parent of every one of these routes.
 */

import { useRouterState } from "@tanstack/react-router";
import { LAUNCHABLE_VIEW_IDS } from "@/components/projects/project-apps";

export function useAppTakeover(): boolean {
  const mainView = useRouterState({
    select: (state) =>
      state.matches.findLast((match) => match.staticData.mainView)?.staticData
        .mainView,
  });
  if (!mainView) return false;
  return (LAUNCHABLE_VIEW_IDS as readonly string[]).includes(mainView);
}
