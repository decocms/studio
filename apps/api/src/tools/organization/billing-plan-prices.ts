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
let cache: { at: number; prices: PlanPrice[] } | null = null;

/** Exported for tests — a cached snapshot outlives a test's settings mock. */
export function clearPlanPriceCache(): void {
  cache = null;
}

async function loadPlanPrices(): Promise<PlanPrice[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.prices;

  const entries = Object.entries(getSettings().stripePlanPriceIds ?? {});
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
  // Only cache a complete read. Caching a partial one would pin a half-empty
  // catalog in memory for the whole TTL after a transient Stripe blip.
  if (prices.length === entries.length) cache = { at: Date.now(), prices };
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
