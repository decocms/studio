import { describe, expect, test } from "bun:test";
import {
  computeTopUpChargeCents,
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
  test("collects address + tax ID, and writes back only for a saved customer", () => {
    const guest = toStripeForm(taxAndAddressParams(null));
    expect(guest.get("billing_address_collection")).toBe("required");
    expect(guest.get("tax_id_collection[enabled]")).toBe("true");
    // Stripe rejects customer_update without a `customer` on the session.
    expect(guest.has("customer_update[address]")).toBe(false);

    const saved = toStripeForm(taxAndAddressParams("cus_1"));
    expect(saved.get("billing_address_collection")).toBe("required");
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
