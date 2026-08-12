import { describe, expect, it } from "bun:test";
import {
  DRAFT_TOKEN_TTL_MS,
  signDraftToken,
  verifyDraftToken,
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
