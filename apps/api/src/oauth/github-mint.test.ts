import { describe, expect, it } from "bun:test";
import { resolveGhsExpiry } from "./github-mint";
import { GHS_TOKEN_LIFETIME_MS } from "./token-refresh";

describe("resolveGhsExpiry", () => {
  const now = Date.now();

  it("uses server-provided expiry when it is strictly in the future", () => {
    const futureExpiry = new Date(now + 30 * 60 * 1000); // 30 min from now
    const result = resolveGhsExpiry(futureExpiry, now);
    expect(result).toBe(futureExpiry);
  });

  it("falls back to mintStartedAt + GHS_TOKEN_LIFETIME_MS when expiresAt is null", () => {
    const result = resolveGhsExpiry(null, now);
    expect(result.getTime()).toBe(now + GHS_TOKEN_LIFETIME_MS);
  });

  it("falls back when server-provided expiry is in the past (clock skew)", () => {
    const pastExpiry = new Date(now - 1000);
    const result = resolveGhsExpiry(pastExpiry, now);
    expect(result.getTime()).toBe(now + GHS_TOKEN_LIFETIME_MS);
  });

  it("falls back when server-provided expiry equals mintStartedAt (not strictly future)", () => {
    const exactNow = new Date(now);
    const result = resolveGhsExpiry(exactNow, now);
    expect(result.getTime()).toBe(now + GHS_TOKEN_LIFETIME_MS);
  });

  it("fallback expiry is ~55 minutes from mint start", () => {
    const result = resolveGhsExpiry(null, now);
    const diffMs = result.getTime() - now;
    expect(diffMs).toBe(55 * 60 * 1000);
  });
});
