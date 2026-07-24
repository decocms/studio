/**
 * Subscription-standing predicates — the ONE source for "is anyone paying?"
 * decisions. Two deliberately different questions:
 *
 *  - subscriptionInGoodStanding: does the org's payment state unlock seats
 *    (the middleware seat gate) and grant the allowance (the benefit sync)?
 *    `past_due` counts — Stripe dunning grace: access survives a failed card
 *    until Stripe gives up (which arrives as a status change).
 *
 *  - hasChargeableSubscription: may we charge the saved card right now
 *    (seat-change proration mirror, preview)? `past_due` is EXCLUDED —
 *    never stack prorated charges on a card already failing its renewal.
 *
 * invoiced (contract) orgs have no Stripe status: always in good standing,
 * never chargeable (their invoicing is end-of-cycle from seat_change_log).
 * A null billing row fails open — orgs predating billing are legacy.
 */

export function subscriptionInGoodStanding(
  billing: { billingMode: string; status: string } | null,
): boolean {
  if (!billing || billing.billingMode !== "self_serve") return true;
  return billing.status === "active" || billing.status === "past_due";
}

export function hasChargeableSubscription<
  T extends {
    billingMode: string;
    status: string;
    stripeSubscriptionId: string | null;
  },
>(billing: T | null): billing is T & { stripeSubscriptionId: string } {
  return (
    !!billing &&
    billing.billingMode === "self_serve" &&
    billing.status === "active" &&
    billing.stripeSubscriptionId !== null
  );
}
