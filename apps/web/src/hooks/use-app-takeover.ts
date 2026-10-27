/** Whether the route is an app launched from a project; apps open with the chat closed. */

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
