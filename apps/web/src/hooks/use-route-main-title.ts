import { useRouterState } from "@tanstack/react-router";
import type { TranslationKey } from "@/i18n/en/index.ts";
import { useT } from "@/i18n/use-t.ts";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** Translation key for a fixed route-owned Main title. */
    mainTitleKey?: TranslationKey;
  }
}

interface RouteMainTitleMatch {
  staticData?: { mainTitleKey?: TranslationKey };
}

/** Resolve inherited route metadata with the deepest declaration winning. */
export function resolveRouteMainTitleKey(
  matches: readonly RouteMainTitleMatch[],
): TranslationKey | undefined {
  for (let i = matches.length - 1; i >= 0; i--) {
    const key = matches[i]?.staticData?.mainTitleKey;
    if (key) return key;
  }
  return undefined;
}

/** The fixed title owned by the currently matched Main route, if it has one. */
export function useRouteMainTitle(): string | undefined {
  const t = useT();
  const key = useRouterState({
    select: (state) => resolveRouteMainTitleKey(state.matches),
  });
  return key ? t(key) : undefined;
}
