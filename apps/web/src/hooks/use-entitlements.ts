/**
 * The org's plan entitlements: which features it includes, and the AI usage bar.
 *
 * Mesh hardcodes only the feature KEYS (public strings); every value is
 * answered per-org by the gateway at runtime, so a gate moves without a mesh
 * deploy. One query, shared by the billing card and by every gate.
 */

import { useQuery, type QueryClient } from "@tanstack/react-query";
import type { StudioToolIO } from "@decocms/shared/tools/tool-io";
import { KEYS } from "@/lib/query-keys";
import { callStudioTool } from "@/lib/studio-tools";
import { useProjectContextOptional } from "@/sdk";
import { usePublicConfigOptional } from "@/hooks/use-public-config";

type Entitlements = StudioToolIO["AI_PLAN_ENTITLEMENTS"]["output"];

/** Dollars to the micro-dollars the bar's numerator and denominator are in. */
const MICROS_PER_USD = 1_000_000;

/**
 * Advance the usage bar by a turn's own cost, without waiting for the provider.
 *
 * The bar's numerator is OpenRouter's per-key usage counter, and that counter
 * settles asynchronously: a refetch the instant a turn ends routinely returns
 * the PRE-turn number. Invalidating there therefore did nothing visible — the
 * bar sat at the same percentage through a whole session and read as broken,
 * which is the bug this exists for. The turn's cost is already known here (it
 * is what the per-message cost pill renders), so the client can move the bar
 * itself and let the next natural refetch replace the estimate with the
 * gateway's truth.
 *
 * Does nothing without a denominator — an older gateway omits it, and a
 * gateway that could not read usage sends `usage: null`, which must stay
 * unknown rather than become a number we made up.
 *
 * ponytail: the reconcile can step the bar BACK a little if the provider is
 * still settling when it lands. Acceptable against a bar that never moved at
 * all; if the flicker bites, make the merge monotonic per `periodStart` rather
 * than adding a timer.
 */
export function bumpUsageOptimistically(
  queryClient: QueryClient,
  orgId: string,
  spentUsd: number,
): void {
  if (!(spentUsd > 0)) return;
  queryClient.setQueryData(
    KEYS.aiPlanEntitlements(orgId),
    (prev: Entitlements | undefined): Entitlements | undefined => {
      if (!prev?.usage) return prev;
      const usage = prev.usage;
      if (!usage.limitMicros || usage.usedMicros === null) return prev;
      const usedMicros = usage.usedMicros + spentUsd * MICROS_PER_USD;
      const percent = Math.min(1, usedMicros / usage.limitMicros);
      return {
        ...prev,
        usage: {
          ...usage,
          usedMicros,
          percent,
          // Mirrors the gateway's own thresholds (computeUsageBar): an estimate
          // that crosses into warn must LOOK like warn, or the colour and the
          // number disagree until the next read.
          state: percent >= 1 ? "exhausted" : percent >= 0.8 ? "warn" : "ok",
        },
      };
    },
  );
}

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
    // One retry, not three and not none. Every ACCESS gate fails open, so a
    // failed read costs little there — but `useModelDisclosure` fails CLOSED on
    // `isSuccess`, and this query is invalidated after every assistant turn
    // (chat-context `onFinish`), so with no retry at all a single blip stripped
    // model names, the per-message cost pill and the session cost from a
    // paying Ultra org's screen mid-thread. Three backed-off retries is what
    // turned Billing & AI into a hanging page, because `useFeaturesSettled`
    // holds a render on `isPending`; one is a single extra round trip.
    retry: 1,
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
  // Offline, React Query's default `networkMode: "online"` parks an enabled
  // query at `fetchStatus: "paused"` with `isPending` true — neither idle nor
  // loading, and no answer is coming until the connection returns. Waiting on
  // that is how a gated tab body became a permanent skeleton while every
  // ungated tab rendered. Treat it as settled and let the gates fail open.
  if (fetchStatus === "paused") return true;
  return !isPending;
}

/**
 * Whether this org may be told which model ran its work, and what it cost.
 *
 * §1 and §6 of the pricing model: consumption is a PERCENT, the one place money
 * appears is a top-up, and below Ultra the org is never told the model's NAME
 * either — the tier is its vocabulary, not the model or its price.
 *
 * The one gate here that fails CLOSED, and deliberately not `useFeature`.
 * Fail-open is right for ACCESS — locking a paying org out of its CMS over one
 * blipped fetch is the worse bug — and wrong for DISCLOSURE: "never told" and
 * "told for the first frame of every mount, every org switch, and for the whole
 * session whenever the read fails" are different promises, and it was the
 * second one. So this wants a real success, not the absence of an answer.
 *
 * Plans off is still "exactly as before": nothing is withheld.
 */
export function useModelDisclosure(): boolean {
  const plansEnabled = usePlansEnabled();
  const { isSuccess, data } = useEntitlements();
  return modelDisclosureAllowed({
    plansEnabled,
    isSuccess,
    modelChoice: data?.features?.model_choice,
  });
}

/** The rule itself, so it can be tested without a query client. */
export function modelDisclosureAllowed({
  plansEnabled,
  isSuccess,
  modelChoice,
}: {
  plansEnabled: boolean;
  isSuccess: boolean;
  modelChoice: boolean | undefined;
}): boolean {
  if (!plansEnabled) return true;
  return isSuccess && modelChoice === true;
}
