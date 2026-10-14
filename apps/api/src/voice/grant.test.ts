import { describe, expect, test } from "bun:test";
import { VOICE_SESSION_TTL_MS } from "@decocms/shared/voice";
import { signVoiceGrant, verifyVoiceGrant } from "./grant";

const secret = "synthetic-voice-signing-secret";
const now = 1_800_000_000_000;
const claims = {
  sessionId: "e90993c7-bf2c-48b8-9d3d-7a06f0b26741",
  organizationId: "org_example",
  userId: "user_example",
  threadId: "thread_example",
  expiresAt: now + VOICE_SESSION_TTL_MS,
};

describe("voice grants", () => {
  test("binds the principal, organization, thread, session and expiry", () => {
    const token = signVoiceGrant(claims, secret);
    expect(verifyVoiceGrant(token, secret, now)).toEqual(claims);
    expect(token.split(".")).toHaveLength(2);
    expect(verifyVoiceGrant(token, "another-secret", now)).toBeNull();
    expect(verifyVoiceGrant(token, secret, claims.expiresAt)).toBeNull();
    expect(verifyVoiceGrant(token, secret, now - 1)).toBeNull();
  });
  test("rejects tampering and malformed or oversized credentials", () => {
    const token = signVoiceGrant(claims, secret);
    const payload = Buffer.from(
      JSON.stringify({ ...claims, organizationId: "org_other" }),
    ).toString("base64url");
    expect(
      verifyVoiceGrant(`${payload}.${token.split(".")[1]}`, secret, now),
    ).toBeNull();
    for (const invalid of ["", ".", "a.b.c", "a.b", "x".repeat(4097)]) {
      expect(verifyVoiceGrant(invalid, secret, now)).toBeNull();
    }
    expect(() => signVoiceGrant(claims, "")).toThrow();
  });
});
