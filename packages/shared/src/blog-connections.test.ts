import { describe, expect, test } from "bun:test";
import {
  blogConnectionStatus,
  blogConnectionsMissingMessage,
  isBlogConnection,
  isBlogConnectionsMissing,
  pickBlogConnection,
} from "./blog-connections";

const VTEX_KEYS = { accountName: "acme", appKey: "k", appToken: "t" };

describe("isBlogConnection", () => {
  test("by app name or registry id", () => {
    expect(isBlogConnection("vtex", { app_name: "vtex" })).toBe(true);
    expect(isBlogConnection("vtex", { app_id: "deco/vtex" })).toBe(true);
    expect(isBlogConnection("ga4", { app_id: "deco/google-analytics" })).toBe(
      true,
    );
    expect(isBlogConnection("ga4", { app_name: "vtex" })).toBe(false);
  });

  test("a name that only contains the word is not it", () => {
    expect(isBlogConnection("vtex", { app_name: "vtex-orders" })).toBe(false);
  });
});

describe("pickBlogConnection", () => {
  test("an active one beats a newer inactive one", () => {
    const picked = pickBlogConnection("vtex", [
      {
        id: "old",
        app_name: "vtex",
        status: "active",
        updated_at: "2026-01-01",
      },
      {
        id: "new",
        app_name: "vtex",
        status: "error",
        updated_at: "2026-10-01",
      },
      { id: "ga", app_name: "google-analytics", status: "active" },
    ]);
    expect(picked?.id).toBe("old");
  });

  test("among equals, the newest", () => {
    const picked = pickBlogConnection("vtex", [
      { id: "a", app_name: "vtex", status: "active", updated_at: "2026-01-01" },
      { id: "b", app_name: "vtex", status: "active", updated_at: "2026-02-01" },
    ]);
    expect(picked?.id).toBe("b");
  });

  test("none is null", () => {
    expect(pickBlogConnection("ga4", [])).toBeNull();
  });
});

describe("blogConnectionStatus", () => {
  test("missing, inactive, unconfigured, in that order", () => {
    expect(blogConnectionStatus("vtex", null, true).gap).toBe("missing");
    expect(
      blogConnectionStatus(
        "vtex",
        { id: "v", status: "inactive", configuration_state: VTEX_KEYS },
        true,
      ).gap,
    ).toBe("inactive");
    expect(
      blogConnectionStatus(
        "vtex",
        {
          id: "v",
          status: "active",
          configuration_state: { accountName: "acme" },
        },
        true,
      ).gap,
    ).toBe("unconfigured");
  });

  test("VTEX with its keys is ready, sign-in or not", () => {
    expect(
      blogConnectionStatus(
        "vtex",
        { id: "v", status: "active", configuration_state: VTEX_KEYS },
        false,
      ),
    ).toEqual({ connectionId: "v", gap: null });
  });

  test("GA4 needs a property and a usable sign-in", () => {
    const ga4 = {
      id: "g",
      status: "active",
      configuration_state: { propertyId: "123" },
    };
    expect(blogConnectionStatus("ga4", ga4, true).gap).toBeNull();
    expect(blogConnectionStatus("ga4", ga4, false).gap).toBe("unauthorized");
    expect(
      blogConnectionStatus(
        "ga4",
        { ...ga4, configuration_state: { propertyId: "  " } },
        true,
      ).gap,
    ).toBe("unconfigured");
  });
});

test("the refusal names what is missing and is recognized", () => {
  const err = new Error(blogConnectionsMissingMessage(["vtex", "ga4"]));
  expect(err.message).toBe("blog-connections-missing: vtex, ga4");
  expect(isBlogConnectionsMissing(err)).toBe(true);
  expect(isBlogConnectionsMissing(new Error("other"))).toBe(false);
});
