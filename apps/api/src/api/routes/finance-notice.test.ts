import { afterEach, describe, expect, it } from "bun:test";
import {
  financeSiteResolutionBodySchema,
  isFinanceServiceToken,
} from "./finance-notice";

const original = process.env.ORGANIZATION_NOTICES_API_KEY;

afterEach(() => {
  if (original === undefined) delete process.env.ORGANIZATION_NOTICES_API_KEY;
  else process.env.ORGANIZATION_NOTICES_API_KEY = original;
});

describe("isFinanceServiceToken", () => {
  it("fails closed when the service token is not configured", () => {
    delete process.env.ORGANIZATION_NOTICES_API_KEY;
    expect(isFinanceServiceToken("anything")).toBe(false);
  });

  it("accepts only the configured finance token", () => {
    process.env.ORGANIZATION_NOTICES_API_KEY = "notices-secret";
    expect(isFinanceServiceToken("notices-secret")).toBe(true);
    expect(isFinanceServiceToken("wrong-secret")).toBe(false);
  });
});

describe("financeSiteResolutionBodySchema", () => {
  it("normalizes and deduplicates valid site slugs", () => {
    expect(
      financeSiteResolutionBodySchema.parse({
        siteSlugs: [" Store-One ", "store-one", "store-two"],
      }),
    ).toEqual({ siteSlugs: ["store-one", "store-two"] });
  });

  it("rejects empty, malformed, and oversized site lists", () => {
    expect(
      financeSiteResolutionBodySchema.safeParse({ siteSlugs: [] }).success,
    ).toBe(false);
    expect(
      financeSiteResolutionBodySchema.safeParse({ siteSlugs: ["not/a/site"] })
        .success,
    ).toBe(false);
    expect(
      financeSiteResolutionBodySchema.safeParse({
        siteSlugs: Array.from({ length: 501 }, (_, index) => `site-${index}`),
      }).success,
    ).toBe(false);
  });
});
