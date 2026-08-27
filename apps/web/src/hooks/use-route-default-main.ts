/**
 * The matched route's default `?main` tab.
 *
 * Path = which page, search = how that page is laid out. A destination route
 * (`/$org/home`, `/$org/tasks`, …) owns the page, so it also owns which main
 * panel tab shows when the URL names none — and only then: an explicit `?main=`
 * (the `0` closed sentinel included) always wins. This is one more input to the
 * existing default chain in `resolveDefaultPanelState` / `resolveActiveTabAndOpen`,
 * sitting just above the agent's own `defaultMainView`, not a new concept.
 *
 * The default travels as route `staticData` rather than as a search default
 * because the panel machinery reads search from the pathless agent-shell match,
 * which sits ABOVE the destination route and so never sees a leaf validator's
 * output.
 */
import { useRouterState } from "@tanstack/react-router";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** The `?main` tab id this route falls back to. Declared in `router.tsx`. */
    defaultMain?: string;
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
