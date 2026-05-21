import { describe, expect, it } from "bun:test";
import { signRequest, verifyRequest } from "./hmac";

const SECRET = "test-secret-32-bytes-or-more-padding-padding";

function makeHeaders(input: {
  secret?: string;
  method?: string;
  path?: string;
  body?: string;
  timestampOverride?: number;
  nonceOverride?: string;
}): Record<string, string> {
  return {
    ...signRequest({
      secret: input.secret ?? SECRET,
      method: input.method ?? "POST",
      path: input.path ?? "/_decopilot_vm/dispatch",
      body: input.body ?? "{}",
      timestamp: input.timestampOverride,
      nonce: input.nonceOverride,
    }),
  };
}

describe("HMAC request signing", () => {
  it("verifies a freshly signed request", () => {
    const headers = makeHeaders({});
    const ok = verifyRequest({
      secret: SECRET,
      method: "POST",
      path: "/_decopilot_vm/dispatch",
      body: "{}",
      headers,
      seenNonce: () => false,
    });
    expect(ok).toEqual({ valid: true });
  });

  it("rejects mismatched body", () => {
    const headers = makeHeaders({ body: "{}" });
    const result = verifyRequest({
      secret: SECRET,
      method: "POST",
      path: "/_decopilot_vm/dispatch",
      body: '{"x":1}',
      headers,
      seenNonce: () => false,
    });
    expect(result.valid).toBe(false);
  });

  it("rejects mismatched secret", () => {
    const headers = makeHeaders({});
    const result = verifyRequest({
      secret: "wrong-secret-32-bytes-padding-padding-padding",
      method: "POST",
      path: "/_decopilot_vm/dispatch",
      body: "{}",
      headers,
      seenNonce: () => false,
    });
    expect(result.valid).toBe(false);
  });

  it("rejects timestamps drifting more than 30s", () => {
    const headers = makeHeaders({
      timestampOverride: Math.floor(Date.now() / 1000) - 60,
    });
    const result = verifyRequest({
      secret: SECRET,
      method: "POST",
      path: "/_decopilot_vm/dispatch",
      body: "{}",
      headers,
      seenNonce: () => false,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("timestamp_drift");
  });

  it("rejects replayed nonces", () => {
    const headers = makeHeaders({ nonceOverride: "fixed-nonce" });
    const result = verifyRequest({
      secret: SECRET,
      method: "POST",
      path: "/_decopilot_vm/dispatch",
      body: "{}",
      headers,
      seenNonce: (n) => n === "fixed-nonce",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("nonce_replay");
  });
});
