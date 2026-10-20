/**
 * The client-side plan gate for a whole view.
 *
 * This logic used to be the prologue of `TabBody` in
 * `layouts/main-panel-tabs/index.tsx`: one switch rendered every view, so one
 * `featureForTab(activeTab)` check covered all of them. #7202 and #7250 split
 * that switch into a route per view, which deleted the single door — so the
 * gate becomes a component each gated route wraps itself in.
 *
 * What that costs, and it is worth saying plainly: the old shape could not be
 * forgotten, because the switch WAS the gate — every view went through it, so a
 * deep link obeyed the plan for free. This one can be forgotten: a new gated
 * view has to remember to wrap itself, and the six that exist today
 * (`tasks`, `project-tasks`, `agent-monitor` and the three Site Editor routes)
 * are the whole list. `featureForTab` still answers the same tab -> feature
 * question for the sidebar's locks, so the two can disagree now where they
 * previously could not; keep them in step.
 *
 * The server-side gate (`requiresFeature` on the tool, the BFF's own checks)
 * is what actually refuses the data either way — this is the upsell, not the
 * enforcement, which is what makes the regression above survivable rather than
 * a hole.
 *
 * Three states, and the middle one is the reason this is not two lines:
 *
 *  - NOT SETTLED: `useFeature` fails OPEN while the answer is in flight, which
 *    is right for access and wrong for rendering — the gated view would mount,
 *    fire its own queries against BFF routes that answer 403, and then be
 *    replaced by the paywall. A layout thrash plus a lazy chunk downloaded for
 *    a view the org cannot open. Withhold the body WITHOUT showing the paywall:
 *    this org may well own the feature, and a paywall that flashes at a paying
 *    customer is worse than a skeleton.
 *  - DENIED: the paywall, over a populated but inert backdrop where one is
 *    given, so the dialog is not sitting on an empty screen.
 *  - ALLOWED (and the fail-open default): the view.
 */

import type { ReactNode } from "react";
import { useSearch } from "@tanstack/react-router";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { FeaturePaywall } from "@/components/feature-paywall";
import { useFeature, useFeaturesSettled } from "@/hooks/use-entitlements";
import type { Feature } from "@/hooks/use-entitlements";
import { usePanelNavigate } from "@/layouts/main-panel-tabs/use-panel-navigate";

export function FeatureGate({
  feature,
  backdrop,
  children,
}: {
  feature: Feature;
  /** Rendered behind the paywall dialog when the plan withholds the view. A
   *  view with nothing cheap to populate (a live sandbox iframe, a suspense
   *  query keyed on a runtime client) passes nothing and gets a plain
   *  backdrop — see the Known gaps in the PR. */
  backdrop?: ReactNode;
  children: ReactNode;
}) {
  const { openPanel } = usePanelNavigate();
  // Dismissal is the URL's own `?mainpanel=false`, which the panel writes.
  // It used to be component state, and the body is mounted once for the life
  // of the panel, so a dismissed feature stayed dismissed: every later click
  // on that view rendered an EMPTY panel with no content, no paywall and no
  // way back to the upsell. `openPanel` clears the param, so asking for the
  // view again asks for the paywall again.
  const { mainpanel } = useSearch({ strict: false }) as {
    mainpanel?: boolean;
  };
  const allowed = useFeature(feature);
  const settled = useFeaturesSettled();

  if (!settled) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-3 p-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="min-h-0 flex-1 w-full" />
      </div>
    );
  }

  if (allowed) return children;

  if (mainpanel === false) return null;

  return (
    <div className="relative h-full min-h-0">
      {backdrop}
      <FeaturePaywall
        feature={feature}
        // Home, because the project's default view can be the gated surface
        // itself — leaving them on it would reopen the dialog forever.
        onDismiss={() => openPanel("overview")}
        onSeePlans={() => {}}
      />
    </div>
  );
}
