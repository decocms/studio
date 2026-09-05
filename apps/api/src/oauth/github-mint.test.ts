import { describe, expect, it } from "bun:test";
import { extractMintedToken, resolveGhsExpiry } from "./github-mint";
import { GHS_TOKEN_LIFETIME_MS, RECONNECT_ERROR } from "./token-refresh";

describe("extractMintedToken", () => {
  it("returns the token and parsed expiry on a well-formed result", () => {
    const result = extractMintedToken({
      structuredContent: {
        token: "ghs_abc",
        expiresAt: "2026-01-01T00:00:00Z",
      },
    });
    expect(result.accessToken).toBe("ghs_abc");
    expect(result.expiresAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("defaults expiresAt to null when absent", () => {
    const result = extractMintedToken({
      structuredContent: { token: "ghs_abc" },
    });
    expect(result.expiresAt).toBeNull();
  });

  it("throws when the tool reports isError", () => {
    expect(() =>
      extractMintedToken({
        isError: true,
        structuredContent: { token: "ghs_abc" },
      }),
    ).toThrow(RECONNECT_ERROR);
  });

  it("throws when token is missing", () => {
    expect(() => extractMintedToken({ structuredContent: {} })).toThrow(
      RECONNECT_ERROR,
    );
  });

  it("throws when token is not a string (malformed tool response)", () => {
    expect(() =>
      extractMintedToken({
        structuredContent: { token: { nested: "object" } as unknown as string },
      }),
    ).toThrow(RECONNECT_ERROR);
  });

  it("falls back to null expiry when expiresAt is not a string", () => {
    const result = extractMintedToken({
      structuredContent: {
        token: "ghs_abc",
        expiresAt: 12345 as unknown as string,
      },
    });
    expect(result.expiresAt).toBeNull();
  });

  it("falls back to null expiry when expiresAt is an unparseable string", () => {
    const result = extractMintedToken({
      structuredContent: { token: "ghs_abc", expiresAt: "not-a-date" },
    });
    expect(result.expiresAt).toBeNull();
  });
});

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
