import { describe, expect, test } from "bun:test";
import { toStripeForm } from "./stripe-api";

describe("toStripeForm", () => {
  test("encodes nested objects and arrays in Stripe's bracket form", () => {
    const form = toStripeForm({
      mode: "subscription",
      line_items: [{ price: "price_1", quantity: 3 }],
      subscription_data: { metadata: { orgId: "org_1" } },
    });
    expect(form.get("mode")).toBe("subscription");
    expect(form.get("line_items[0][price]")).toBe("price_1");
    expect(form.get("line_items[0][quantity]")).toBe("3");
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

  test("encodes the seat-change preview shape (nested items in details)", () => {
    const form = toStripeForm({
      subscription: "sub_1",
      subscription_details: {
        items: [{ id: "si_1", quantity: 5 }],
        proration_behavior: "always_invoice",
      },
    });
    expect(form.get("subscription_details[items][0][id]")).toBe("si_1");
    expect(form.get("subscription_details[items][0][quantity]")).toBe("5");
    expect(form.get("subscription_details[proration_behavior]")).toBe(
      "always_invoice",
    );
  });
});
