/**
 * ORGANIZATION_BILLING_PLAN_PRICES — what each tier actually costs, read off
 * the Stripe Price objects the checkout charges.
 *
 * The UI used to carry its own table of BRL amounts. Nothing read it at
 * checkout, so a stale number there misquoted an org without changing what its
 * card was charged — the worst kind of wrong, because it looks right. These
 * amounts come from the same price ids `STRIPE_PLAN_PRICE_IDS` maps to tiers,
 * which makes the quote and the charge the same fact.
 */

import { z } from "zod";
import { retrievePrice, StripeApiError } from "../../billing/stripe-api";
import { defineTool } from "../../core/define-tool";
import { getSettings } from "../../settings";
import { requireAuth } from "../../core/studio-context";

const priceSchema = z.object({
  planId: z.string(),
  /** Minor units — centavos for BRL. The UI divides; nothing here rounds. */
  amountCents: z.number(),
  /** ISO 4217, lowercase, as Stripe returns it. */
  currency: z.string(),
  /** 'month' for every tier today. Present so a yearly price can't be
   *  rendered as a monthly one without the UI noticing. */
  interval: z.string().nullable(),
});

type PlanPrice = z.infer<typeof priceSchema>;

/**
 * Prices change about never, and every org asks for the same handful. One
 * process-wide snapshot rather than a fetch per org per page load.
 *
 * ponytail: per-pod memory, so a price edited in Stripe takes up to the TTL to
 * show everywhere. A price change is a deploy-scale event; if that ever stops
 * being true, invalidate on the `price.updated` webhook instead of shortening
 * this.
 */
const CACHE_TTL_MS = 10 * 60_000;
/** A read that came back short is held only long enough to stop a stampede. */
const PARTIAL_CACHE_TTL_MS = 30_000;
let cache: { at: number; prices: PlanPrice[]; ttlMs: number } | null = null;

/** Exported for tests — a cached snapshot outlives a test's settings mock. */
export function clearPlanPriceCache(): void {
  cache = null;
}

async function loadPlanPrices(): Promise<PlanPrice[]> {
  if (cache && Date.now() - cache.at < cache.ttlMs) return cache.prices;

  // ONE price per plan, and specifically the one `priceIdForPlan` would sell.
  // The map allows two prices for the same tier (a legacy price beside a
  // current one). Checkout takes the first; the UI used to collapse the rows
  // with Object.fromEntries, where the LAST wins — so an org could be quoted
  // R$250 and charged R$1200, which is the exact divergence this tool exists to
  // remove. Quoting only the sellable price makes the two agree by
  // construction rather than by both sides happening to sort the same way.
  const seen = new Set<string>();
  const entries = Object.entries(getSettings().stripePlanPriceIds ?? {}).filter(
    ([, planId]) => {
      if (seen.has(planId)) return false;
      seen.add(planId);
      return true;
    },
  );
  const settled = await Promise.all(
    entries.map(async ([priceId, planId]): Promise<PlanPrice | null> => {
      try {
        const price = await retrievePrice(priceId);
        // A metered or "customer chooses" price has no fixed amount, so there
        // is no monthly figure to quote. Drop it rather than render 0.
        if (price.unit_amount === null) return null;
        return {
          planId,
          amountCents: price.unit_amount,
          currency: price.currency,
          interval: price.recurring?.interval ?? null,
        };
      } catch (err) {
        // One unreadable price must not blank the whole catalog — the other
        // tiers still have a real number to show.
        console.warn(
          `plan price ${priceId} (${planId}) unreadable:`,
          err instanceof StripeApiError ? err.message : err,
        );
        return null;
      }
    }),
  );
  const prices = settled.filter((p): p is PlanPrice => p !== null);
  // A partial read is cached too, but briefly. Caching it for the full TTL
  // would pin a half-empty catalog after a transient Stripe blip; NOT caching
  // it at all was worse, because some gaps never close — a price with no fixed
  // amount (metered/tiered) is dropped on every read, and a deleted or mistyped
  // price id 404s for ever. Either one meant this tool, which sits on a page
  // every org loads, hit Stripe N times per request indefinitely. Short TTL
  // bounds that while still letting the gap heal on its own.
  const complete = prices.length === entries.length;
  cache = {
    at: Date.now(),
    prices,
    ttlMs: complete ? CACHE_TTL_MS : PARTIAL_CACHE_TTL_MS,
  };
  return prices;
}

export const ORGANIZATION_BILLING_PLAN_PRICES = defineTool({
  name: "ORGANIZATION_BILLING_PLAN_PRICES",
  description:
    "The monthly price of each purchasable plan, read from Stripe. Empty when no plan prices are configured.",
  annotations: {
    title: "Plan Prices",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({ prices: z.array(priceSchema) }),

  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    return { prices: await loadPlanPrices() };
  },
});
