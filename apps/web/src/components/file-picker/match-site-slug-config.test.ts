import { describe, expect, test } from "bun:test";
import type { FileConfigInfo } from "@/hooks/use-file-configs";
import { matchSiteSlugConfig } from "./match-site-slug-config";

function config(
  id: string,
  overrides: Partial<FileConfigInfo>,
): FileConfigInfo {
  return {
    id,
    name: id,
    description: null,
    bucket: `${id}-bucket`,
    region: "auto",
    endpoint: null,
    forcePathStyle: false,
    prefix: null,
    publicUrlBase: null,
    credentialType: "static",
    refreshUrl: null,
    siteSlug: null,
    createdBy: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedBy: "test",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("matchSiteSlugConfig", () => {
  test("matches managed siteSlug", () => {
    const matching = config("managed", { siteSlug: "storefront" });
    expect(
      matchSiteSlugConfig(
        [config("other", { siteSlug: "other" }), matching],
        "storefront",
      ),
    ).toBe(matching);
  });

  test("matches bucket named after the slug", () => {
    const matching = config("bucket", { bucket: "storefront" });
    expect(matchSiteSlugConfig([matching], "storefront")).toBe(matching);
  });

  test("matches deco-assets bucket named after the slug", () => {
    const matching = config("assets", { bucket: "deco-assets-storefront" });
    expect(matchSiteSlugConfig([matching], "storefront")).toBe(matching);
  });

  test("matches case-insensitively", () => {
    const matching = config("mixed", {
      bucket: "DECO-ASSETS-StoreFront",
      siteSlug: "STOREFRONT",
    });
    expect(matchSiteSlugConfig([matching], "storefront")).toBe(matching);
  });

  test("returns null for an empty slug", () => {
    expect(matchSiteSlugConfig([config("one", {})], "")).toBeNull();
  });

  test("returns null when nothing matches", () => {
    expect(
      matchSiteSlugConfig([config("one", { siteSlug: "other" })], "storefront"),
    ).toBeNull();
  });

  test("returns the first matching config", () => {
    const first = config("first", { siteSlug: "storefront" });
    const second = config("second", { bucket: "storefront" });
    expect(matchSiteSlugConfig([first, second], "storefront")).toBe(first);
  });

  test("slugifies a free-form project title before matching (#6296)", () => {
    const matching = config("assets", { bucket: "deco-assets-deco-cms" });
    expect(matchSiteSlugConfig([matching], "Deco CMS")).toBe(matching);
  });

  test("returns null when a slugified title is empty", () => {
    expect(matchSiteSlugConfig([config("one", {})], "!!!")).toBeNull();
  });
});
