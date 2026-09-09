/**
 * The org's plan entitlements: which features it includes, and the AI usage bar.
 *
 * Mesh hardcodes only the feature KEYS (public strings); every value is
 * answered per-org by the gateway at runtime, so a gate moves without a mesh
 * deploy. One query, shared by the billing card and by every gate.
 */

import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import { callStudioTool } from "@/lib/studio-tools";
import { useProjectContextOptional } from "@/sdk";
import { usePublicConfigOptional } from "@/hooks/use-public-config";

/**
 * Whether this deployment has tiered plans switched on at all
 * (STUDIO_PLANS_ENABLED). Off is the default and off means "behave exactly as
 * before": no entitlements query, so every `useFeature` below fails open, and
 * no plan card. Self-hosting and local dev never see the feature unless they
 * ask for it.
 */
export function usePlansEnabled(): boolean {
  return usePublicConfigOptional()?.plansEnabled === true;
}

/** The gate-able surfaces. Mirrors FEATURE_KEYS in the gateway's plans-shape. */
export type Feature =
  | "cms"
  | "chat"
  | "kanban"
  | "monitoring"
  | "model_choice"
  | "diagnostic"
  | "diagnostic_enriched"
  /** May buy AI credits on top of the allowance — see the gateway's plans. */
  | "credits";

export function useEntitlements() {
  // Optional on purpose: the gates below are read by leaf components (a
  // message's cost label) that also render outside the shell. No org is one
  // more form of "no answer", which `useFeature` already allows.
  const ctx = useProjectContextOptional();
  const orgSlug = ctx?.org.slug;
  const plansEnabled = usePlansEnabled();
  return useQuery({
    queryKey: KEYS.aiPlanEntitlements(ctx?.org.id ?? "none"),
    // Disabled is one more form of "no answer", which every gate below already
    // allows — so the flag needs no second check at any call site.
    enabled: !!orgSlug && plansEnabled,
    staleTime: 60_000,
    // No retries. Every gate fails OPEN, so a failed read costs nothing but a
    // moment of ungated UI — while RETRYING costs seconds of `isPending`, and
    // `useFeaturesSettled` holds a render on that. Three backed-off retries of
    // a 403 turned Billing & AI into a hanging page. Fail open, fast.
    retry: false,
    // `callStudioTool` rather than `useStudioTools()`: that hook requires the
    // project context this one deliberately treats as optional.
    // Deliberately NOT swallowed into `null`: a failure has to stay a failure
    // so the billing card can SAY it could not read the plan. Swallowing it
    // made every error render as an absent card — invisible, unexplainable.
    // The gates still fail open, because `useFeature` treats undefined data
    // the same as no answer.
    queryFn: () =>
      callStudioTool(orgSlug!, "AI_PLAN_ENTITLEMENTS", { providerId: "deco" }),
  });
}

/**
 * Whether the org's plan includes `feature`. `null` asks nothing and is always
 * allowed — hooks cannot be called conditionally, so an ungated surface still
 * has to call this.
 *
 * Fails OPEN: while the query is in flight, and whenever the gateway could not
 * be read, everything reads as included. This is product gating, not access
 * control — the gateway is what actually refuses the spend, and locking a
 * paying org out of its CMS because one fetch blipped is the worse bug.
 */
export function useFeature(feature: Feature | null): boolean {
  const { data } = useEntitlements();
  if (!feature || !data) return true;
  return data.features[feature] === true;
}

/**
 * Whether the plan answer has SETTLED — i.e. `useFeature` below is returning a
 * real decision rather than its fail-open default.
 *
 * The gates fail open while the query is in flight, which is right for
 * correctness (a slow gateway must not lock anyone out) and wrong for
 * rendering: the ungated UI paints for a frame and then swaps, which reads as
 * a flicker. A surface the plan can REMOVE should wait for this; a surface the
 * plan only annotates should not, and should keep failing open.
 *
 * True when there is nothing to wait for at all — plans off, or no org — so a
 * self-hosted deployment never holds a render on a query it will not run.
 */
export function useFeaturesSettled(): boolean {
  const plansEnabled = usePlansEnabled();
  const { isPending, fetchStatus } = useEntitlements();
  if (!plansEnabled) return true;
  // A disabled query is `pending` forever with fetchStatus "idle" — that is
  // "nothing to wait for", not "still loading".
  if (fetchStatus === "idle") return true;
  return !isPending;
}

/**
 * Whether to show per-thread dollar amounts.
 *
 * §1 of the pricing model: consumption is a PERCENT, and the one place money
 * appears is a top-up. Below Ultra an org is never told what a message cost —
 * the same gate that withholds the model's NAME (`model_choice`), because the
 * tier is the org's vocabulary, not the model or its price.
 *
 * Named rather than inlined because the reason a *cost* label reads a
 * *model-choice* flag is not guessable at the call site.
 */
export function useShowThreadCost(): boolean {
  return useFeature("model_choice");
}
