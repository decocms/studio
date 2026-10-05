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

/** What a tier costs per month, as Stripe states it. */
export type PlanPrice = {
  /** Minor units — cents for USD. */
  amountCents: number;
  /** ISO 4217, lowercase from Stripe; `Intl` accepts either case. */
  currency: string;
  interval: string | null;
};

/**
 * The monthly price of every purchasable tier, straight off the Stripe Price
 * objects checkout charges.
 *
 * This replaced a hardcoded BRL table. Nothing in that table reached checkout,
 * so a stale number quoted one amount while the card was charged another —
 * and a misquote that renders confidently is worse than no price at all.
 * Hence no fallback here: a plan Stripe can't price renders nothing.
 *
 * Not keyed by org — prices are a property of the deployment, so every org
 * shares one cache entry.
 */
export function usePlanPrices() {
  const studio = useStudioTools();
  const plansEnabled = usePlansEnabled();
  return useQuery({
    queryKey: KEYS.aiPlanPrices(),
    enabled: plansEnabled,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const { prices } = await studio.call(
        "ORGANIZATION_BILLING_PLAN_PRICES",
        {},
      );
      return Object.fromEntries(
        prices.map((p) => [
          p.planId,
          {
            amountCents: p.amountCents,
            currency: p.currency,
            interval: p.interval,
          } satisfies PlanPrice,
        ]),
      ) as Record<string, PlanPrice>;
    },
  });
}

/** One place that turns a price into the string every surface shows. */
export function formatPlanPrice(price: PlanPrice, language: string): string {
  return (price.amountCents / 100).toLocaleString(language, {
    style: "currency",
    currency: price.currency.toUpperCase(),
    // Whole units: these are $50 / $500, and ".00" on every card is noise. A
    // tier ever priced with cents will need this relaxed.
    maximumFractionDigits: 0,
  });
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
 * plan: Kanban skips a rung. Reads straight off the cheapest-first catalog,
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

/**
 * Plans deco staff assign by contract. They are not on the ladder, so an org on
 * one is shown neither the catalog nor a checkout — only who to talk to.
 */
const STAFF_MANAGED_PLAN_IDS: ReadonlySet<string> = new Set([
  "custom",
  "ai_service",
]);

export function isStaffManagedPlan(planId: string | null | undefined): boolean {
  return !!planId && STAFF_MANAGED_PLAN_IDS.has(planId);
}

// TODO: confirm contact address
export const SALES_CONTACT_HREF = "mailto:sales@deco.cx";

/**
 * Cheapest-first, which is the order every rung here is derived from.
 *
 * `free` is dropped: the gateway still lists it, but it is the absence of a
 * plan (no features at all), not a rung anyone picks — so an org on it has
 * index -1 and its next rung is the first one.
 */
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
      return plans.filter((p) => p.id !== "free");
    },
  });
}

/**
 * Seedling, leafy stem, flower — the ladder drawn as growth. The last rung is
 * Custom, which is not in the catalog and is drawn at `plans.length`.
 *
 * Keyed by POSITION, not by plan id: the catalog is ordered cheapest-first
 * (the suggested upgrade is `plans[i + 1]`), so a renamed tier still reads as
 * growth and a fourth one keeps the last plant rather than rendering an empty
 * `<use>`. Colours are categorical, never semantic — `destructive` on the top
 * tier would read as an error rather than as the richest rung.
 */
const PLAN_PLANTS = [
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
