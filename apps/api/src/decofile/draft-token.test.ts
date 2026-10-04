import { describe, expect, it } from "bun:test";
import {
  DRAFT_TOKEN_TTL_MS,
  OVERLAY_GRANT_TTL_MS,
  overlayGrant,
  signDraftToken,
  signOverlayGrant,
  siteToken,
  verifyDraftToken,
  verifySiteToken,
} from "./draft-token";

const scope = {
  organizationId: "org-1",
  virtualMcpId: "vm-1",
  branch: "main",
};

describe("draft token", () => {
  it("round-trips a valid scope", () => {
    const token = signDraftToken(scope);
    expect(verifyDraftToken(token, scope)).toBe(true);
  });

  it("rejects any scope mismatch", () => {
    const token = signDraftToken(scope);
    expect(verifyDraftToken(token, { ...scope, organizationId: "org-2" })).toBe(
      false,
    );
    expect(verifyDraftToken(token, { ...scope, virtualMcpId: "vm-2" })).toBe(
      false,
    );
    expect(verifyDraftToken(token, { ...scope, branch: "dev" })).toBe(false);
  });

  it("rejects an expired token", () => {
    const now = Date.now();
    const token = signDraftToken({ ...scope, nowMs: now });
    expect(
      verifyDraftToken(token, {
        ...scope,
        nowMs: now + DRAFT_TOKEN_TTL_MS + 1_000,
      }),
    ).toBe(false);
    expect(
      verifyDraftToken(token, {
        ...scope,
        nowMs: now + DRAFT_TOKEN_TTL_MS - 1_000,
      }),
    ).toBe(true);
  });

  it("rejects tampered payloads and garbage", () => {
    const token = signDraftToken(scope);
    const [payload, mac] = token.split(".") as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ o: "org-1", m: "vm-1", b: "dev", e: 9999999999 }),
    ).toString("base64url");
    expect(verifyDraftToken(`${forged}.${mac}`, scope)).toBe(false);
    expect(verifyDraftToken(payload, scope)).toBe(false);
    expect(verifyDraftToken("", scope)).toBe(false);
    expect(verifyDraftToken("not.a.token", scope)).toBe(false);
  });
});

describe("overlay grant", () => {
  const version = "a".repeat(64);

  it("authorizes exactly one site's overlay version for one hour", () => {
    const now = Date.now();
    const { token, expiresAt } = signOverlayGrant({
      site: "acme",
      version,
      nowMs: now,
    });
    const e = Math.floor((now + OVERLAY_GRANT_TTL_MS) / 1000);
    expect(OVERLAY_GRANT_TTL_MS).toBe(60 * 60 * 1000);
    expect(overlayGrant(token, { site: "acme", nowMs: now })).toEqual({
      version,
      expiresAt: e,
    });
    expect(overlayGrant(token, { site: "other", nowMs: now })).toBe(null);
    expect(
      overlayGrant(token, {
        site: "acme",
        nowMs: now + OVERLAY_GRANT_TTL_MS + 1_000,
      }),
    ).toBe(null);
    expect(Date.parse(expiresAt)).toBe(e * 1000);
  });

  it("is not interchangeable with the legacy branch token", () => {
    const legacy = signDraftToken(scope);
    expect(overlayGrant(legacy, { site: "acme" })).toBe(null);
    const { token } = signOverlayGrant({ site: "acme", version });
    expect(verifyDraftToken(token, scope)).toBe(false);
  });

  it("rejects a forged payload", () => {
    const { token } = signOverlayGrant({ site: "acme", version });
    const mac = token.split(".")[1];
    const forged = Buffer.from(
      JSON.stringify({ t: "overlay", s: "acme", v: "b".repeat(64), e: 9e9 }),
    ).toString("base64url");
    expect(overlayGrant(`${forged}.${mac}`, { site: "acme" })).toBe(null);
  });
});

describe("site token", () => {
  it("verifies only for its own site", () => {
    const token = siteToken("acme");
    expect(token.startsWith("dst_")).toBe(true);
    expect(verifySiteToken("acme", token)).toBe(true);
    expect(verifySiteToken("other", token)).toBe(false);
    expect(verifySiteToken("acme", `${token}x`)).toBe(false);
    expect(verifySiteToken("acme", "")).toBe(false);
  });
});
