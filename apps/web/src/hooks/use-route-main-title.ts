import { useRouterState } from "@tanstack/react-router";
import type { TranslationKey } from "@/i18n/en/index.ts";
import { useT } from "@/i18n/use-t.ts";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** Translation key for a fixed route-owned Main title. */
    mainTitleKey?: TranslationKey;
    /** URL parameter used as the immediate title for a dynamic detail route. */
    mainTitleParam?: "appSlug" | "itemId";
    /** Optional extra parent shown by a nested route's Main breadcrumb. */
    mainBreadcrumbParentKey?: TranslationKey;
  }
}

interface RouteMainTitleMatch {
  staticData?: {
    mainTitleKey?: TranslationKey;
    mainTitleParam?: "appSlug" | "itemId";
    mainBreadcrumbParentKey?: TranslationKey;
  };
  params?: Record<string, string>;
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
  const paramTitle = useRouterState({
    select: (state) => resolveRouteMainTitleParam(state.matches),
  });
  const key = useRouterState({
    select: (state) => resolveRouteMainTitleKey(state.matches),
  });
  return paramTitle ?? (key ? t(key) : undefined);
}

/** Resolve a dynamic route title without waiting for its data query. */
export function resolveRouteMainTitleParam(
  matches: readonly RouteMainTitleMatch[],
): string | undefined {
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    const param = match?.staticData?.mainTitleParam;
    const value = param ? match.params?.[param] : undefined;
    if (value?.trim()) return value;
  }
  return undefined;
}

/** Resolve the deepest optional parent contributed by a nested route. */
export function resolveRouteMainBreadcrumbParentKey(
  matches: readonly RouteMainTitleMatch[],
): TranslationKey | undefined {
  for (let i = matches.length - 1; i >= 0; i--) {
    const key = matches[i]?.staticData?.mainBreadcrumbParentKey;
    if (key) return key;
  }
  return undefined;
}

export function useRouteMainBreadcrumbParentTitle(): string | undefined {
  const t = useT();
  const key = useRouterState({
    select: (state) => resolveRouteMainBreadcrumbParentKey(state.matches),
  });
  return key ? t(key) : undefined;
}
