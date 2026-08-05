import { describe, expect, test } from "bun:test";
import { isManagedConfigFor } from "./deco-sites";

describe("isManagedConfigFor", () => {
  test("already the managed config for the slug — nothing to do", () => {
    expect(
      isManagedConfigFor(
        { credentialType: "managed", siteSlug: "als-storefront" },
        "als-storefront",
      ),
    ).toBe(true);
  });

  test("legacy pre-tenancy config on the old bucket must be upgraded", () => {
    expect(
      isManagedConfigFor(
        { credentialType: "sts-session", siteSlug: null },
        "als-storefront",
      ),
    ).toBe(false);
    expect(
      isManagedConfigFor(
        { credentialType: "static", siteSlug: null },
        "als-storefront",
      ),
    ).toBe(false);
  });

  test("managed but pointing at another slug must be re-pointed", () => {
    expect(
      isManagedConfigFor(
        { credentialType: "managed", siteSlug: "other-site" },
        "als-storefront",
      ),
    ).toBe(false);
  });

  test("siteSlug casing does not force a pointless rewrite", () => {
    expect(
      isManagedConfigFor(
        { credentialType: "managed", siteSlug: "ALS-Storefront" },
        "als-storefront",
      ),
    ).toBe(true);
  });
});
