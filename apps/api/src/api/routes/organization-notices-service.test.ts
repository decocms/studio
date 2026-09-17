import { afterEach, describe, expect, it } from "bun:test";
import {
  isOrganizationNoticesApiKey,
  organizationNoticeSiteResolutionBodySchema,
} from "./organization-notices-service";

const original = process.env.ORGANIZATION_NOTICES_API_KEY;

afterEach(() => {
  if (original === undefined) delete process.env.ORGANIZATION_NOTICES_API_KEY;
  else process.env.ORGANIZATION_NOTICES_API_KEY = original;
});

describe("isOrganizationNoticesApiKey", () => {
  it("fails closed when the service token is not configured", () => {
    delete process.env.ORGANIZATION_NOTICES_API_KEY;
    expect(isOrganizationNoticesApiKey("anything")).toBe(false);
  });

  it("accepts only the configured API key", () => {
    process.env.ORGANIZATION_NOTICES_API_KEY = "notices-secret";
    expect(isOrganizationNoticesApiKey("notices-secret")).toBe(true);
    expect(isOrganizationNoticesApiKey("wrong-secret")).toBe(false);
  });
});

describe("organizationNoticeSiteResolutionBodySchema", () => {
  it("normalizes and deduplicates valid site slugs", () => {
    expect(
      organizationNoticeSiteResolutionBodySchema.parse({
        siteSlugs: [" Store-One ", "store-one", "store-two"],
      }),
    ).toEqual({ siteSlugs: ["store-one", "store-two"] });
  });

  it("rejects empty, malformed, and oversized site lists", () => {
    expect(
      organizationNoticeSiteResolutionBodySchema.safeParse({ siteSlugs: [] })
        .success,
    ).toBe(false);
    expect(
      organizationNoticeSiteResolutionBodySchema.safeParse({
        siteSlugs: ["not/a/site"],
      }).success,
    ).toBe(false);
    expect(
      organizationNoticeSiteResolutionBodySchema.safeParse({
        siteSlugs: Array.from({ length: 501 }, (_, index) => `site-${index}`),
      }).success,
    ).toBe(false);
  });
});
