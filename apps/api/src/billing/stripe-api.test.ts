import { describe, expect, test } from "bun:test";
import {
  checkoutIdempotencyKey,
  computeTopUpChargeCents,
  plannedOrphanRefunds,
  taxAndAddressParams,
  toStripeForm,
} from "./stripe-api";
import { toUsdCreditCents } from "./exchange-rate";

describe("toStripeForm", () => {
  test("encodes nested objects and arrays in Stripe's bracket form", () => {
    const form = toStripeForm({
      mode: "subscription",
      line_items: [{ price: "price_1", quantity: 1 }],
      subscription_data: { metadata: { orgId: "org_1" } },
    });
    expect(form.get("mode")).toBe("subscription");
    expect(form.get("line_items[0][price]")).toBe("price_1");
    expect(form.get("line_items[0][quantity]")).toBe("1");
    expect(form.get("subscription_data[metadata][orgId]")).toBe("org_1");
  });

  test("drops null/undefined and keeps falsy scalars", () => {
    const form = toStripeForm({
      a: undefined,
      b: null,
      c: 0,
      d: false,
    });
    expect(form.has("a")).toBe(false);
    expect(form.has("b")).toBe(false);
    expect(form.get("c")).toBe("0");
    expect(form.get("d")).toBe("false");
  });

  test("empty arrays and nested null/undefined encode to nothing", () => {
    const form = toStripeForm({
      items: [],
      nested: { keep: "x", drop: undefined, gone: null },
    });
    expect([...form.keys()]).toEqual(["nested[keep]"]);
  });
});

describe("taxAndAddressParams", () => {
  test("collects address + a required CPF/CNPJ custom field", () => {
    const guest = toStripeForm(taxAndAddressParams(null));
    expect(guest.get("billing_address_collection")).toBe("required");

    // A no-op for BR buyers: the country isn't in Checkout's supported list.
    expect(guest.has("tax_id_collection[enabled]")).toBe(false);
    expect(guest.has("tax_id_collection[required]")).toBe(false);

    expect(guest.get("custom_fields[0][key]")).toBe("taxid");
    expect(guest.get("custom_fields[0][type]")).toBe("text");
    expect(guest.get("custom_fields[0][label][type]")).toBe("custom");
    expect(guest.get("custom_fields[0][label][custom]")).toBe("CPF / CNPJ");
    // Pinned rather than left to Stripe's `false` default — it gates payment.
    expect(guest.get("custom_fields[0][optional]")).toBe("false");
    // Bare CPF (11 digits) through formatted CNPJ (18 chars).
    expect(guest.get("custom_fields[0][text][minimum_length]")).toBe("11");
    expect(guest.get("custom_fields[0][text][maximum_length]")).toBe("18");

    // Stripe rejects customer_update without a `customer` on the session.
    expect(guest.has("customer_update[address]")).toBe(false);
  });

  test("writes back to the customer only when one is saved", () => {
    const saved = toStripeForm(taxAndAddressParams("cus_1"));
    expect(saved.get("billing_address_collection")).toBe("required");
    expect(saved.get("custom_fields[0][key]")).toBe("taxid");
    expect(saved.get("custom_fields[0][optional]")).toBe("false");
    // Required by Stripe once a saved customer meets address collection.
    expect(saved.get("customer_update[address]")).toBe("auto");
    expect(saved.get("customer_update[name]")).toBe("auto");
  });
});

describe("computeTopUpChargeCents", () => {
  test("adds the fee on top of the credited amount (gateway parity: 15%)", () => {
    expect(computeTopUpChargeCents(1000, 15)).toBe(1150);
    expect(computeTopUpChargeCents(10000, 15)).toBe(11500);
    expect(computeTopUpChargeCents(1000, 0)).toBe(1000);
  });

  test("rounds to whole cents", () => {
    expect(computeTopUpChargeCents(333, 15)).toBe(383); // 382.95 → 383
  });
});

describe("toUsdCreditCents (BRL top-up FX)", () => {
  test("BRL centavos convert at the locked rate; USD is identity", () => {
    expect(toUsdCreditCents(5500, "brl", 5.5)).toBe(1000); // R$55 @5.5 = $10
    expect(toUsdCreditCents(1000, "usd", 5.5)).toBe(1000);
    expect(toUsdCreditCents(999, "brl", 5.5)).toBe(182); // rounds
  });
});

/**
 * The double charge, undone. Two checkouts completing before either binds is a
 * double-click or a second tab; the webhook refuses the second and used to only
 * CANCEL it, which stops future billing and returns nothing — leaving the
 * customer charged twice for the one subscription they kept.
 */
describe("plannedOrphanRefunds", () => {
  const SUB = "sub_orphan";

  test("refunds what the orphan's paid invoice actually collected", () => {
    expect(
      plannedOrphanRefunds(SUB, [
        { id: "in_1", amount_paid: 25000, payment_intent: "pi_1" },
      ]),
    ).toEqual([
      {
        paymentIntent: "pi_1",
        amountCents: 25000,
        idempotencyKey: "orphan-refund:sub_orphan:in_1",
      },
    ]);
  });

  test("a key per INVOICE, so two paid invoices are two refunds", () => {
    const planned = plannedOrphanRefunds(SUB, [
      { id: "in_1", amount_paid: 25000, payment_intent: "pi_1" },
      { id: "in_2", amount_paid: 500000, payment_intent: "pi_2" },
    ]);
    expect(planned.map((p) => p.idempotencyKey)).toEqual([
      "orphan-refund:sub_orphan:in_1",
      "orphan-refund:sub_orphan:in_2",
    ]);
    expect(planned.reduce((s, p) => s + p.amountCents, 0)).toBe(525000);
  });

  test("the key is stable across a webhook redelivery — Stripe replays, not re-refunds", () => {
    const once = plannedOrphanRefunds(SUB, [
      { id: "in_1", amount_paid: 25000, payment_intent: "pi_1" },
    ]);
    const again = plannedOrphanRefunds(SUB, [
      { id: "in_1", amount_paid: 25000, payment_intent: "pi_1" },
    ]);
    expect(again[0]?.idempotencyKey).toBe(once[0]?.idempotencyKey);
  });

  test("collects nothing back from invoices that collected nothing", () => {
    // A downgrade's credit invoice and a zero proration are both `paid` with
    // amount_paid 0 — refunding those would send money that never arrived.
    expect(
      plannedOrphanRefunds(SUB, [
        { id: "in_credit", amount_paid: 0, payment_intent: "pi_x" },
        { id: "in_neg", amount_paid: -474999, payment_intent: "pi_y" },
      ]),
    ).toEqual([]);
  });

  test("skips an invoice with no card payment to reverse", () => {
    // Settled from customer balance: paid, non-zero, but no payment intent.
    expect(
      plannedOrphanRefunds(SUB, [
        { id: "in_bal", amount_paid: 25000, payment_intent: null },
        { id: "in_none", amount_paid: 25000 },
      ]),
    ).toEqual([]);
  });

  test("reads an expanded payment intent as well as a bare id", () => {
    expect(
      plannedOrphanRefunds(SUB, [
        { id: "in_1", amount_paid: 25000, payment_intent: { id: "pi_exp" } },
      ])[0]?.paymentIntent,
    ).toBe("pi_exp");
  });
});

describe("checkoutIdempotencyKey", () => {
  const AT = new Date("2026-09-15T18:00:00Z");

  test("two clicks for the same org and plan collapse to one session", () => {
    // Stripe replays the first response for a repeated key, so both callers
    // get the SAME Checkout Session — and a Session completes at most once.
    expect(
      checkoutIdempotencyKey({
        organizationId: "org_1",
        planId: "pro",
        lastStripeEventAt: AT,
      }),
    ).toBe(
      checkoutIdempotencyKey({
        organizationId: "org_1",
        planId: "pro",
        lastStripeEventAt: AT,
      }),
    );
  });

  test("different orgs never share a session", () => {
    expect(checkoutIdempotencyKey({ organizationId: "org_1" })).not.toBe(
      checkoutIdempotencyKey({ organizationId: "org_2" }),
    );
  });

  test("a changed plan is a different purchase", () => {
    expect(
      checkoutIdempotencyKey({ organizationId: "org_1", planId: "pro" }),
    ).not.toBe(
      checkoutIdempotencyKey({ organizationId: "org_1", planId: "ultra" }),
    );
  });

  test("the watermark salt frees the org after its situation changes", () => {
    // Subscribe, cancel, come back inside Stripe's 24h key window: without the
    // salt the org would be handed its own already-completed session and could
    // never re-subscribe.
    expect(
      checkoutIdempotencyKey({
        organizationId: "org_1",
        lastStripeEventAt: AT,
      }),
    ).not.toBe(
      checkoutIdempotencyKey({
        organizationId: "org_1",
        lastStripeEventAt: new Date(AT.getTime() + 1000),
      }),
    );
  });

  test("a never-billed org is stable rather than random", () => {
    expect(checkoutIdempotencyKey({ organizationId: "org_new" })).toBe(
      checkoutIdempotencyKey({
        organizationId: "org_new",
        lastStripeEventAt: null,
      }),
    );
  });
});
