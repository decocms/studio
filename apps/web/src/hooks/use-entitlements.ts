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

/** The gate-able surfaces. Mirrors FEATURE_KEYS in the gateway's plans-shape. */
export type Feature =
  | "cms"
  | "chat"
  | "kanban"
  | "monitoring"
  | "model_choice"
  | "diagnostic"
  | "diagnostic_enriched";

export function useEntitlements() {
  // Optional on purpose: the gates below are read by leaf components (a
  // message's cost label) that also render outside the shell. No org is one
  // more form of "no answer", which `useFeature` already allows.
  const ctx = useProjectContextOptional();
  const orgSlug = ctx?.org.slug;
  return useQuery({
    queryKey: KEYS.aiPlanEntitlements(ctx?.org.id ?? "none"),
    enabled: !!orgSlug,
    staleTime: 60_000,
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
