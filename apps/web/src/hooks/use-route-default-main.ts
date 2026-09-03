/**
 * The matched route's default main-panel tab.
 *
 * Path = which page, search = how that page is laid out. A destination route
 * (`/$org/home`, `/$org/tasks`, …) owns the page, so it also owns which main
 * panel view shows when the URL names none. An explicit child route always
 * wins, while `?mainpanel=` independently controls visibility. This is one
 * input to the existing default chain in `resolveDefaultPanelState` /
 * `resolveActiveTabAndOpen`, sitting above the agent's own `defaultMainView`.
 *
 * The default travels as route `staticData` rather than as a search default
 * because the panel machinery reads search from the pathless agent-shell match,
 * which sits ABOVE the destination route and so never sees a leaf validator's
 * output.
 */
import { useRouterState } from "@tanstack/react-router";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** The tab id this route opens when no explicit visibility override exists. */
    defaultMain?: string;
    /** The semantic main view owned by the matched route. */
    mainView?: string;
    /** The nested Site Editor surface owned by the matched leaf route. */
    siteEditorView?: "preview" | "content" | "code";
  }
}

export function useRouteDefaultMain(): string | null {
  return useRouterState({
    select: (state) => {
      /** Deepest match wins, so a destination beats any shared parent default. */
      for (let i = state.matches.length - 1; i >= 0; i--) {
        const defaultMain = state.matches[i]?.staticData.defaultMain;
        if (defaultMain) return defaultMain;
      }
      return null;
    },
  });
}
