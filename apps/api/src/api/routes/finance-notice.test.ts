import { afterEach, describe, expect, it } from "bun:test";
import { getSettings, setGlobalSettings } from "@/settings";
import {
  financeSiteResolutionBodySchema,
  isFinanceServiceToken,
} from "./finance-notice";

// The token is read through `getSettings()`, so it is installed through the
// real accessor rather than by poking process.env — and NOT by mock.module'ing
// the settings module, which leaks for the whole shard (see TESTING.md).
const original = getSettings();

function withFinanceToken(token: string | undefined) {
  setGlobalSettings({ ...original, financeServiceToken: token });
}

afterEach(() => {
  setGlobalSettings(original);
});

describe("isFinanceServiceToken", () => {
  it("fails closed when the service token is not configured", () => {
    withFinanceToken(undefined);
    expect(isFinanceServiceToken("anything")).toBe(false);
  });

  it("accepts only the configured finance token", () => {
    // 32 chars: resolveConfig refuses to boot on anything shorter, so a test
    // fixture below the bar would not be reachable in a real deployment.
    const token = "f".repeat(32);
    withFinanceToken(token);
    expect(isFinanceServiceToken(token)).toBe(true);
    expect(isFinanceServiceToken("wrong-secret")).toBe(false);
    expect(isFinanceServiceToken("f".repeat(31))).toBe(false);
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
