/**
 * The page shell every tabbed settings screen shares.
 *
 * A settings group is one sidebar row fanning out into sibling routes shown as
 * tabs (see `settings-tab-groups.ts`). Switching tabs is a route change, so the
 * new page suspends — on its data, and the first time also on its lazy chunk.
 * Whichever boundary catches that suspension decides how much of the screen
 * blinks out, and TanStack wraps every route match in a `<Suspense>` whose
 * fallback is that route's `pendingComponent`. A page that suspends without a
 * boundary of its own therefore takes the heading and the tab strip down with
 * it, which reads as the whole settings screen flashing on every tab click.
 *
 * Both halves of the fix live here:
 *   - `SettingsGroupPage` renders the heading + tabs *above* the boundary, so a
 *     page's own data only ever swaps the content region for a skeleton.
 *   - `settingsGroupPendingComponent(group)` is the route-level
 *     `pendingComponent` (wired in `router.tsx`), painting that same chrome
 *     while the route's chunk loads.
 *
 * Neither hook behind the tab strip suspends (`useCapabilities` and
 * `useOwnedSites` are plain `useQuery`), so the chrome is always safe to render
 * outside the boundary — including from inside a Suspense fallback.
 */

import { Suspense, type ComponentProps, type ReactNode } from "react";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Main } from "@/components/main";
import { ErrorBoundary } from "@/components/error-boundary";
import { SettingsSubnav } from "@/components/settings/settings-subnav";
import { useT } from "@/i18n/use-t";
import type { SettingsGroupKey } from "./settings-tab-groups";

/** Placeholder for the content region while a tab's data or chunk loads. */
export function SettingsContentSkeleton() {
  const t = useT();
  return (
    <div
      role="status"
      aria-label={t("common.loading")}
      data-testid="settings-content-loading"
      className="flex flex-col gap-4"
    >
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

interface SettingsGroupPageProps {
  group: SettingsGroupKey;
  /** Shown in place of `children` while they suspend. Chrome stays put. */
  fallback?: ReactNode;
  /** Shown in place of `children` when they throw. */
  errorFallback?: ComponentProps<typeof ErrorBoundary>["fallback"];
  /** Extra classes for the content stack (e.g. a tighter `gap-6`). */
  className?: string;
  children: ReactNode;
}

export function SettingsGroupPage({
  group,
  fallback,
  errorFallback,
  className,
  children,
}: SettingsGroupPageProps) {
  return (
    <>
      <SettingsSubnav group={group} />
      <div className="h-full overflow-y-auto">
        <Main.Container width="standard">
          <Main.Stack gap="spacious" className={className}>
            <ErrorBoundary fallback={errorFallback}>
              <Suspense fallback={fallback ?? <SettingsContentSkeleton />}>
                {children}
              </Suspense>
            </ErrorBoundary>
          </Main.Stack>
        </Main.Container>
      </div>
    </>
  );
}

/**
 * Route `pendingComponent` for a tabbed settings route. Replaces the global
 * `defaultPendingComponent` (a full-screen spinner) so a cold chunk load keeps
 * the heading and tab strip on screen.
 */
export function settingsGroupPendingComponent(group: SettingsGroupKey) {
  return function SettingsGroupPending() {
    return (
      <SettingsGroupPage group={group}>
        <SettingsContentSkeleton />
      </SettingsGroupPage>
    );
  };
}
