import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  mapSubscriptionStatus,
  parseStripeEvent,
  planIdForPrices,
  planIdForStripe,
  subscriptionFunnelEvent,
  verifyStripeSignature,
  type HandledStripeEvent,
  type StripeEvent,
} from "./stripe-webhook";

const SECRET = "whsec_test_secret";
const T = 1_700_000_000;
/** Verification clock aligned with the signing timestamp. */
const NOW = T * 1000;

function hmac(body: string, secret: string, t = T): string {
  return createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
}

function sign(body: string, secret = SECRET, t = T): string {
  return `t=${t},v1=${hmac(body, secret, t)}`;
}

describe("verifyStripeSignature", () => {
  test("accepts Stripe's v1 scheme over the raw body", () => {
    const body = '{"type":"invoice.paid"}';
    expect(verifyStripeSignature(body, sign(body), SECRET, NOW)).toBe(true);
  });

  test("rejects a tampered body, wrong secret, and malformed headers", () => {
    const body = '{"type":"invoice.paid"}';
    const header = sign(body);
    expect(verifyStripeSignature(`${body} `, header, SECRET, NOW)).toBe(false);
    expect(verifyStripeSignature(body, sign(body, "other"), SECRET, NOW)).toBe(
      false,
    );
    expect(verifyStripeSignature(body, "garbage", SECRET, NOW)).toBe(false);
    expect(verifyStripeSignature(body, undefined, SECRET, NOW)).toBe(false);
    expect(verifyStripeSignature(body, header, undefined, NOW)).toBe(false);
  });

  test("rejects timestamps outside the ±5 min tolerance (replay window)", () => {
    const body = '{"type":"invoice.paid"}';
    const header = sign(body);
    expect(verifyStripeSignature(body, header, SECRET, (T + 299) * 1000)).toBe(
      true,
    );
    expect(verifyStripeSignature(body, header, SECRET, (T + 301) * 1000)).toBe(
      false,
    );
    // Future-skewed timestamps are just as invalid.
    expect(verifyStripeSignature(body, header, SECRET, (T - 301) * 1000)).toBe(
      false,
    );
    // Non-numeric timestamp must not sneak past the tolerance check.
    const v1 = hmac(body, SECRET);
    expect(verifyStripeSignature(body, `t=abc,v1=${v1}`, SECRET, NOW)).toBe(
      false,
    );
  });

  test("accepts ANY v1 entry — secret rotation sends one per active secret", () => {
    const body = '{"type":"invoice.paid"}';
    const good = hmac(body, SECRET);
    const stale = hmac(body, "whsec_rotated_out");
    expect(
      verifyStripeSignature(body, `t=${T},v1=${stale},v1=${good}`, SECRET, NOW),
    ).toBe(true);
    expect(
      verifyStripeSignature(body, `t=${T},v1=${good},v1=${stale}`, SECRET, NOW),
    ).toBe(true);
    expect(verifyStripeSignature(body, `t=${T},v1=${stale}`, SECRET, NOW)).toBe(
      false,
    );
  });
});

describe("parseStripeEvent", () => {
  test("extracts the handled slice", () => {
    const event = parseStripeEvent(
      JSON.stringify({
        id: "evt_1",
        type: "invoice.paid",
        created: T,
        livemode: false,
        data: { object: { id: "in_1" } },
      }),
    );
    expect(event).toEqual({
      id: "evt_1",
      type: "invoice.paid",
      created: T,
      livemode: false,
      data: { object: { id: "in_1" } },
    });
  });

  test("rejects non-JSON, wrong shapes, and data.object null", () => {
    expect(parseStripeEvent("not json")).toBeNull();
    expect(parseStripeEvent('"a string"')).toBeNull();
    expect(parseStripeEvent("{}")).toBeNull();
    expect(parseStripeEvent('{"type":"x"}')).toBeNull();
    // typeof null === "object" — a signed-but-degenerate payload must be a
    // 400, not a 500 that Stripe redelivers for days.
    expect(parseStripeEvent('{"type":"x","data":{"object":null}}')).toBeNull();
    expect(parseStripeEvent('{"type":1,"data":{"object":{}}}')).toBeNull();
  });
});

describe("mapSubscriptionStatus", () => {
  test("active/trialing serve, past_due is grace, everything else is out", () => {
    expect(mapSubscriptionStatus("active")).toBe("active");
    expect(mapSubscriptionStatus("trialing")).toBe("active");
    expect(mapSubscriptionStatus("past_due")).toBe("past_due");
    expect(mapSubscriptionStatus("canceled")).toBe("canceled");
    expect(mapSubscriptionStatus("unpaid")).toBe("canceled");
    expect(mapSubscriptionStatus(undefined)).toBe("canceled");
  });
});

describe("subscriptionFunnelEvent", () => {
  const ORG = "org_1";
  const handled: HandledStripeEvent = { handled: true, organizationId: ORG };
  const evt = (
    type: string,
    object: Record<string, unknown> = {},
    livemode?: boolean,
  ): StripeEvent => ({ type, livemode, data: { object } });

  test("unhandled results and test-mode traffic map to nothing", () => {
    expect(
      subscriptionFunnelEvent(evt("invoice.paid"), {
        handled: false,
        reason: "unknown org",
      }),
    ).toBeNull();
    expect(
      subscriptionFunnelEvent(evt("invoice.paid", {}, false), handled),
    ).toBeNull();
  });

  test("topUp wins over the type mapping and carries the amount", () => {
    const r = subscriptionFunnelEvent(evt("checkout.session.completed"), {
      ...handled,
      topUp: { creditCents: 5000, referenceId: "stripe-topup:cs_1" },
    });
    expect(r).toEqual({
      name: "credits_topup_succeeded",
      organizationId: ORG,
      properties: { credit_cents: 5000 },
    });
  });

  test("checkout (both delivery types) → subscription_started", () => {
    expect(
      subscriptionFunnelEvent(evt("checkout.session.completed"), handled)?.name,
    ).toBe("subscription_started");
    expect(
      subscriptionFunnelEvent(
        evt("checkout.session.async_payment_succeeded"),
        handled,
      )?.name,
    ).toBe("subscription_started");
  });

  test("subscription.updated carries mapped status and churn intent", () => {
    const r = subscriptionFunnelEvent(
      evt("customer.subscription.updated", {
        status: "active",
        cancel_at_period_end: true,
      }),
      handled,
    );
    expect(r?.name).toBe("subscription_updated");
    expect(r?.properties).toEqual({
      status: "active",
      cancel_at_period_end: true,
    });
  });

  test("subscription.deleted → subscription_canceled", () => {
    expect(
      subscriptionFunnelEvent(evt("customer.subscription.deleted"), handled)
        ?.name,
    ).toBe("subscription_canceled");
  });

  test("invoice.paid → subscription_renewed, EXCEPT the first invoice", () => {
    expect(
      subscriptionFunnelEvent(
        evt("invoice.paid", { billing_reason: "subscription_cycle" }),
        handled,
      )?.name,
    ).toBe("subscription_renewed");
    // The creation invoice is the subscription_started moment, not a renewal.
    expect(
      subscriptionFunnelEvent(
        evt("invoice.paid", { billing_reason: "subscription_create" }),
        handled,
      ),
    ).toBeNull();
  });

  test("unmapped event types map to nothing", () => {
    expect(
      subscriptionFunnelEvent(evt("customer.created"), handled),
    ).toBeNull();
  });
});

/**
 * The join between money and entitlement. Before this existed, `AI_PLAN_SET`
 * granted any tier for free and a cancelled subscription revoked nothing: the
 * billing row read `canceled` while the org kept every paid feature and its
 * full AI allowance, indefinitely.
 */
describe("planIdForStripe", () => {
  const MAP = { price_pro: "pro", price_ultra: "ultra" };
  const sub = (priceId: string) => ({
    items: { data: [{ price: { id: priceId } }] },
  });

  test("an active subscription grants the tier its price maps to", () => {
    expect(planIdForStripe("active", sub("price_ultra"), MAP)).toBe("ultra");
    expect(planIdForStripe("active", sub("price_pro"), MAP)).toBe("pro");
  });

  test("a cancelled subscription drops the org to free", () => {
    expect(planIdForStripe("canceled", sub("price_ultra"), MAP)).toBe("free");
  });

  /** …including one whose price was unmapped after the fact. An org must never
   *  keep a paid tier because the operator edited the price map. */
  test("drops to free even when the price is not in the map", () => {
    expect(planIdForStripe("canceled", sub("price_gone"), MAP)).toBe("free");
    expect(planIdForStripe("canceled", {}, MAP)).toBe("free");
  });

  /** Dunning grace, matching task-quota.ts — the two must not disagree about
   *  what a delinquent org can do. `undefined` means "leave the plan alone". */
  test("past_due changes nothing while Stripe is still retrying the card", () => {
    expect(
      planIdForStripe("past_due", sub("price_ultra"), MAP),
    ).toBeUndefined();
  });

  /** The safe direction of the asymmetry: a price nobody priced grants
   *  nothing, rather than defaulting to some tier. */
  test("an active subscription on an unmapped price grants nothing", () => {
    expect(
      planIdForStripe("active", sub("price_unknown"), MAP),
    ).toBeUndefined();
    expect(planIdForStripe("active", {}, MAP)).toBeUndefined();
    expect(planIdForStripe("active", sub("price_pro"), {})).toBeUndefined();
  });

  test("resolves a plan price sitting beside add-on prices", () => {
    const mixed = {
      items: {
        data: [
          { price: { id: "price_addon" } },
          { price: { id: "price_pro" } },
        ],
      },
    };
    expect(planIdForPrices(mixed, MAP)).toBe("pro");
  });

  test("reads a price given as a bare id, as Stripe sends it unexpanded", () => {
    expect(
      planIdForPrices({ items: { data: [{ price: "price_pro" }] } }, MAP),
    ).toBe("pro");
  });
});
