import { describe, expect, it } from "bun:test";
import { SiteSlugImmutableError } from "../../storage/org-sites";
import { assertSiteSlugUnchanged } from "./site-slug-guard";

const site = { title: "Acme Store", metadata: { siteSlug: "acme" } };
const plain = { title: "Marketing helper", metadata: {} };
const legacy = { title: "legacy-shop", metadata: null };

const refused = (
  project: Parameters<typeof assertSiteSlugUnchanged>[0],
  metadata: Record<string, unknown> | null | undefined,
) => {
  try {
    assertSiteSlugUnchanged(project, metadata);
    return false;
  } catch (error) {
    if (error instanceof SiteSlugImmutableError) return true;
    throw error;
  }
};

describe("assertSiteSlugUnchanged", () => {
  it("lets writes that don't touch the slug through", () => {
    expect(refused(site, undefined)).toBe(false);
    expect(refused(site, null)).toBe(false);
    expect(refused(site, { instructions: "x" })).toBe(false);
  });

  it("lets the same slug through, case and spaces aside", () => {
    expect(refused(site, { siteSlug: "acme" })).toBe(false);
    expect(refused(site, { siteSlug: " ACME " })).toBe(false);
  });

  it("refuses changing or clearing a slug", () => {
    expect(refused(site, { siteSlug: "acme-2" })).toBe(true);
    expect(refused(site, { siteSlug: null })).toBe(true);
    expect(refused(site, { siteSlug: "" })).toBe(true);
  });

  it("refuses setting a slug on a project without one", () => {
    expect(refused(plain, { siteSlug: "grab" })).toBe(true);
    expect(refused(plain, { siteSlug: null })).toBe(false);
  });

  it("treats a legacy title slug as the current slug", () => {
    expect(refused(legacy, { siteSlug: "legacy-shop" })).toBe(false);
    expect(refused(legacy, { siteSlug: "other" })).toBe(true);
  });

  it("explains why", () => {
    expect(() => assertSiteSlugUnchanged(site, { siteSlug: "x" })).toThrow(
      "The site id can't change: CDN paths, tokens and asset URLs use it.",
    );
  });
});
