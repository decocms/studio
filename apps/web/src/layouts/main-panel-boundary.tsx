/**
 * The line between the app shell and the main panel — the whole loading
 * contract of this app, in one file.
 *
 * ABOVE the line sits the shell: the boot gate, the sidebar, the panel frame
 * and the composer that lives with them. Nothing up there may suspend once the
 * shell has painted, because the only fallback that can cover the shell is the
 * full-viewport `SplashScreen`, and a splash after paint is a backwards
 * transition. BELOW the line sits the main panel, which is free to suspend as
 * often as it likes: `MainPanelBoundary` catches it and swaps the panel — and
 * only the panel — for `PanelLoading`.
 *
 * So the app has exactly two loading states: the splash while the shell boots,
 * and this one spinner while the panel's content resolves. Anything genuinely
 * optional (a widget that can render as nothing) uses
 * `<Suspense fallback={null}>` instead and is not a loading state at all.
 *
 * The splash is a SINGLE mounted element for the whole boot — one Suspense
 * boundary in `providers/providers.tsx`, held open by `layouts/boot-gate.tsx`.
 * It plays a definite animation, so a second render site is not "the same
 * loading state again", it is a visible restart. Nothing may render a
 * `SplashScreen` besides that boundary; a route that needs a loader names
 * `PanelLoading`, or lets the default supply it.
 *
 * `PanelLoading` is also the router's `defaultPendingComponent`, so it renders
 * at several depths — inside a settings card, inside a chat card, inside the
 * panel frame. It therefore lays out in static flow (`flex-1` + centering)
 * rather than `absolute inset-0`, which would need an incidental positioned
 * ancestor to land anywhere sensible.
 */

import { Suspense, type ReactNode } from "react";
import { useT } from "@/i18n/use-t.ts";
import { Spinner } from "@decocms/ui/components/spinner.tsx";

/** The ONE loader below the line. */
export function PanelLoading() {
  const t = useT();
  return (
    <div
      data-testid="panel-loading"
      className="flex flex-1 h-full w-full items-center justify-center"
    >
      {/* The Spinner is `aria-hidden` unless given a label, and this one is
          held for at least `defaultPendingMinMs` on every route change — so
          without the label a screen reader reads the region as empty rather
          than busy. It is the app's only below-the-line loader; the cost of
          naming it once is nothing next to that. */}
      <Spinner
        className="size-5 text-muted-foreground"
        label={t("common.loading")}
      />
    </div>
  );
}

/** The line itself: everything inside may suspend into `PanelLoading`. */
export function MainPanelBoundary({ children }: { children: ReactNode }) {
  return <Suspense fallback={<PanelLoading />}>{children}</Suspense>;
}
