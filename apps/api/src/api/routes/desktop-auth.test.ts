import { createHmac } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { signSessionCookieValue } from "./desktop-auth";

describe("signSessionCookieValue", () => {
  it("matches better-auth's own HMAC-SHA256 + base64 + URI-escape scheme", () => {
    const token = "raw-session-token-abc123";
    const secret = "test-secret-value";

    const expectedSignature = createHmac("sha256", secret)
      .update(token)
      .digest("base64");
    const expected = encodeURIComponent(`${token}.${expectedSignature}`);

    expect(signSessionCookieValue(token, secret)).toBe(expected);
  });

  it("is deterministic for the same token+secret", () => {
    const a = signSessionCookieValue("tok", "secret");
    const b = signSessionCookieValue("tok", "secret");
    expect(a).toBe(b);
  });

  it("changes when the token changes", () => {
    const a = signSessionCookieValue("tok-1", "secret");
    const b = signSessionCookieValue("tok-2", "secret");
    expect(a).not.toBe(b);
  });

  it("changes when the secret changes", () => {
    const a = signSessionCookieValue("tok", "secret-1");
    const b = signSessionCookieValue("tok", "secret-2");
    expect(a).not.toBe(b);
  });

  it("percent-escapes the standard-base64 signature's special characters", () => {
    // Standard (non-url-safe) base64 can contain '+', '/', '='. The cookie
    // value must be URI-escaped so those never collide with cookie
    // delimiters (';', ',') or get mangled in transit.
    const value = signSessionCookieValue("token", "secret");
    expect(value).not.toContain("+");
    expect(value).not.toContain("/");
    // A trailing '=' from base64 padding would appear un-escaped as '=' —
    // confirm any literal padding survived only in escaped form.
    expect(value.includes("%3D") || !value.includes("=")).toBe(true);
  });

  it("round-trips through decodeURIComponent back to token.signature", () => {
    const token = "another-token";
    const secret = "another-secret";
    const value = signSessionCookieValue(token, secret);
    const decoded = decodeURIComponent(value);
    const dot = decoded.lastIndexOf(".");
    expect(dot).toBeGreaterThan(0);
    expect(decoded.slice(0, dot)).toBe(token);
    const signature = decoded.slice(dot + 1);
    const expectedSignature = createHmac("sha256", secret)
      .update(token)
      .digest("base64");
    expect(signature).toBe(expectedSignature);
  });
});
