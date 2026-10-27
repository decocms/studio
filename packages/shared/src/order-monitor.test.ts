import { describe, expect, test } from "bun:test";
import {
  orderIngestTitle,
  orderStoreLabel,
  vtexAccountOf,
  vtexConnectionLabel,
} from "./order-monitor";

describe("vtexAccountOf", () => {
  test("reads the account and nothing else", () => {
    expect(
      vtexAccountOf({ accountName: " acme ", appKey: "k", appToken: "t" }),
    ).toBe("acme");
  });

  test.each([
    null,
    undefined,
    "acme",
    {},
    { accountName: "  " },
    { accountName: 42 },
  ])("is null for %p", (state) => {
    expect(vtexAccountOf(state)).toBeNull();
  });
});

describe("vtexConnectionLabel", () => {
  test("adds the account the title does not say", () => {
    expect(vtexConnectionLabel("VTEX", "acme")).toBe("VTEX · acme");
  });

  test("does not repeat an account the title already carries", () => {
    expect(vtexConnectionLabel("VTEX · Acme", "acme")).toBe("VTEX · Acme");
  });

  test("is the title when the account is unknown", () => {
    expect(vtexConnectionLabel("VTEX", null)).toBe("VTEX");
  });
});

describe("orderIngestTitle", () => {
  test("names the install after the account", () => {
    expect(orderIngestTitle("acme")).toBe("VTEX order monitoring · acme");
    expect(orderIngestTitle(null)).toBe("VTEX order monitoring");
  });
});

describe("orderStoreLabel", () => {
  test("prefers the VTEX account over the install's title", () => {
    expect(orderStoreLabel("VTEX order monitoring", "acme")).toBe("acme");
    expect(orderStoreLabel("VTEX order monitoring", null)).toBe(
      "VTEX order monitoring",
    );
  });
});
