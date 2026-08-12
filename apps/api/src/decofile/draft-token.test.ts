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
    expect(verifyDraftToken(token, scope)).toBeGreaterThan(0);
  });

  it("rejects any scope mismatch", () => {
    const token = signDraftToken(scope);
    expect(
      verifyDraftToken(token, { ...scope, organizationId: "org-2" }),
    ).toBeNull();
    expect(
      verifyDraftToken(token, { ...scope, virtualMcpId: "vm-2" }),
    ).toBeNull();
    expect(verifyDraftToken(token, { ...scope, branch: "dev" })).toBeNull();
  });

  it("rejects an expired token", () => {
    const now = Date.now();
    const token = signDraftToken({ ...scope, nowMs: now });
    expect(
      verifyDraftToken(token, {
        ...scope,
        nowMs: now + DRAFT_TOKEN_TTL_MS + 1_000,
      }),
    ).toBeNull();
    expect(
      verifyDraftToken(token, {
        ...scope,
        nowMs: now + DRAFT_TOKEN_TTL_MS - 1_000,
      }),
    ).toBeGreaterThan(0);
  });

  it("rejects tampered payloads and garbage", () => {
    const token = signDraftToken(scope);
    const [payload, mac] = token.split(".") as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ o: "org-1", m: "vm-1", b: "dev", e: 9999999999 }),
    ).toString("base64url");
    expect(verifyDraftToken(`${forged}.${mac}`, scope)).toBeNull();
    expect(verifyDraftToken(payload, scope)).toBeNull();
    expect(verifyDraftToken("", scope)).toBeNull();
    expect(verifyDraftToken("not.a.token", scope)).toBeNull();
  });
});
