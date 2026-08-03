import { describe, expect, test } from "bun:test";
import { toStripeForm } from "./stripe-api";

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
