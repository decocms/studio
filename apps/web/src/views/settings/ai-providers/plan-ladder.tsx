import { useQuery } from "@tanstack/react-query";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useProjectContext } from "@/sdk";
import { useStudioTools } from "@/lib/studio-tools";
import { KEYS } from "@/lib/query-keys";
import { usePlansEnabled } from "@/hooks/use-entitlements";

/**
 * The tier ladder: the ordered plans, and the plant that marks a rung.
 *
 * Shared so the plan card and the catalog below it agree — the org's current
 * tier wears the same plant, in the same colour, in both places.
 */

export type Plan = {
  id: string;
  name: string;
  features: Record<string, boolean>;
};

/** The currency every price below is quoted and charged in. */
export const PLAN_PRICE_CURRENCY = "BRL";

/**
 * Monthly subscription price, in whole BRL, keyed by plan id.
 *
 * TEMPORARY. The price actually charged lives in Stripe, mapped by
 * `STRIPE_PLAN_PRICE_IDS`; nothing here is read by checkout, so a wrong number
 * here misquotes an org without changing what its card is charged. Replace
 * this table with the amount off the Stripe price object as soon as the
 * gateway wiring lands — do not add a tier here instead.
 *
 * Keyed by ID, not by rung: a plant on the wrong rung is cosmetic, a price on
 * the wrong plan is a misquote. An id that is missing here (`ai_service`, or
 * any tier added later) renders NO price rather than a guessed one.
 */
const PLAN_PRICES_BRL: Record<string, number> = {
  free: 0,
  pro: 250,
  pro_plus: 1250,
  ultra: 5000,
};

export function planPriceBrl(planId: string): number | undefined {
  return PLAN_PRICES_BRL[planId];
}

/** Every gate a plan can hold, in the order the comparison reads. */
export const FEATURE_ROWS = [
  "chat",
  "cms",
  "credits",
  "monitoring",
  "kanban",
  "model_choice",
  "diagnostic_enriched",
] as const;

/**
 * The cheapest rung that includes `feature` — the one the org has to climb to.
 *
 * "The next possible plan to get that feature", which is not always the next
 * plan: Kanban skips two rungs. Reads straight off the cheapest-first catalog,
 * so it never needs a table of its own to drift from the gateway's answer.
 */
export function planUnlocking(
  plans: Plan[] | undefined,
  feature: string,
): { plan: Plan; index: number } | null {
  if (!plans) return null;
  const index = plans.findIndex((p) => p.features[feature] === true);
  const plan = index >= 0 ? plans[index] : undefined;
  return plan ? { plan, index } : null;
}

/** Cheapest-first, which is the order every rung here is derived from. */
export function usePlanCatalog() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const plansEnabled = usePlansEnabled();
  return useQuery({
    queryKey: KEYS.aiPlanCatalog(org.id),
    enabled: plansEnabled,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { plans } = await studio.call("AI_PLAN_LIST", {
        providerId: "deco",
      });
      return plans;
    },
  });
}

/**
 * Sprout, seedling, leafy stem, flower — the ladder drawn as growth.
 *
 * Keyed by POSITION, not by plan id: the catalog is ordered cheapest-first
 * (the suggested upgrade is `plans[i + 1]`), so a renamed tier still reads as
 * growth and a fifth one keeps the last plant rather than rendering an empty
 * `<use>`. Colours are categorical, never semantic — `destructive` on the top
 * tier would read as an error rather than as the richest rung.
 */
const PLAN_PLANTS = [
  { symbol: "free", color: "text-chart-2" },
  { symbol: "starter", color: "text-chart-4" },
  { symbol: "growth", color: "text-chart-1" },
  { symbol: "scale", color: "text-brand-blue" },
] as const;

const LAST_PLANT = PLAN_PLANTS[PLAN_PLANTS.length - 1]!;

/** The rung's own colour, as a `text-*` class, for anything that tints with it. */
export function planAccent(index: number): string {
  return rungAt(index).color;
}

function rungAt(index: number) {
  return PLAN_PLANTS[Math.min(index, PLAN_PLANTS.length - 1)] ?? LAST_PLANT;
}

export function PlanPlant({
  index,
  className,
}: {
  index: number;
  className?: string;
}) {
  const { symbol, color } = rungAt(index);
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={cn("size-8 shrink-0", color, className)}
    >
      <use href={`/plan-icons.svg#${symbol}-icon`} />
    </svg>
  );
}
