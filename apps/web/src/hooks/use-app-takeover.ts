/**
 * Whether the route showing is an APP rather than a place in the product.
 *
 * A project is not a scope you enter — it is a screen, and the tiles on it
 * LAUNCH things. Something launched takes the screen: the sidebar is how you
 * move between places, and a tool is not a place, so leaving the nav up beside
 * it says you are still browsing when you are working.
 *
 * The breadcrumb stays and is the way back — the project's own crumb is already
 * the parent of every one of these routes. Project-first nav only.
 */

import { useRouterState } from "@tanstack/react-router";
import { LAUNCHABLE_VIEW_IDS } from "@/components/projects/project-apps";
import { useProjectFirstNav } from "@/hooks/use-preferences";

export function useAppTakeover(): boolean {
  const projectFirstNav = useProjectFirstNav();
  /** The site editor's Content and Code tabs are routes of their own, with
   *  their own `mainView`, but they are still the same app: one takeover. */
  const mainView = useRouterState({
    select: (state) => {
      const { staticData } =
        state.matches.findLast((match) => match.staticData.mainView) ?? {};
      return staticData?.siteEditorView ? "site-editor" : staticData?.mainView;
    },
  });
  if (!projectFirstNav || !mainView) return false;
  /** `app` is a pinned connection app, launched from a tile like the rest. */
  return (
    mainView === "app" ||
    (LAUNCHABLE_VIEW_IDS as readonly string[]).includes(mainView)
  );
}
