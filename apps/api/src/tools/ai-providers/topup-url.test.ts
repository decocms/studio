import { describe, expect, it } from "bun:test";
import { AI_PROVIDER_TOPUP_URL } from "./topup-url";

describe("AI_PROVIDER_TOPUP_URL input validation", () => {
  it("accepts a normal top-up amount", () => {
    const result = AI_PROVIDER_TOPUP_URL.inputSchema.safeParse({
      providerId: "deco",
      amountCents: 1000,
    });

    expect(result.success).toBe(true);
  });

  it("accepts the max allowed amount", () => {
    const result = AI_PROVIDER_TOPUP_URL.inputSchema.safeParse({
      providerId: "deco",
      amountCents: 1_000_000,
    });

    expect(result.success).toBe(true);
  });

  it("rejects an amount above the cap", () => {
    const result = AI_PROVIDER_TOPUP_URL.inputSchema.safeParse({
      providerId: "deco",
      amountCents: 1_000_001,
    });

    expect(result.success).toBe(false);
  });

  it("rejects an absurdly large amount that would overflow Stripe's unit_amount limit", () => {
    const result = AI_PROVIDER_TOPUP_URL.inputSchema.safeParse({
      providerId: "deco",
      amountCents: Number.MAX_SAFE_INTEGER,
    });

    expect(result.success).toBe(false);
  });
});
