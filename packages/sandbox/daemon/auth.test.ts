import { describe, expect, it } from "bun:test";
import { signRequest } from "../../../apps/mesh/src/links/protocol/hmac";
import { requireHmacOrToken } from "./auth";

const LINK_SECRET = "test-link-secret-32-chars-min-aaaa";
const DAEMON_TOKEN = "test-daemon-token-32-chars-min-aaaa";

function makeRequest(
  method: string,
  path: string,
  init?: { headers?: Record<string, string>; body?: string },
): Request {
  return new Request(`http://daemon${path}`, {
    method,
    headers: init?.headers,
    body: init?.body,
  });
}

describe("requireHmacOrToken", () => {
  it("accepts a valid HMAC-signed request", () => {
    const sig = signRequest({
      secret: LINK_SECRET,
      method: "POST",
      path: "/_sandbox/exec",
      body: "",
    });
    const req = makeRequest("POST", "/_sandbox/exec", { headers: sig });
    expect(
      requireHmacOrToken(req, "/_sandbox/exec", "", {
        linkSecret: LINK_SECRET,
        daemonToken: DAEMON_TOKEN,
        seenNonce: () => false,
      }),
    ).toBeNull();
  });

  it("rejects an HMAC request signed with the wrong secret", () => {
    const sig = signRequest({
      secret: "wrong-secret-32-chars-min-aaaaaaaa",
      method: "POST",
      path: "/_sandbox/exec",
      body: "",
    });
    const req = makeRequest("POST", "/_sandbox/exec", { headers: sig });
    const result = requireHmacOrToken(req, "/_sandbox/exec", "", {
      linkSecret: LINK_SECRET,
      daemonToken: DAEMON_TOKEN,
      seenNonce: () => false,
    });
    expect(result?.status).toBe(401);
  });

  it("accepts a valid bearer-token request when HMAC headers absent", async () => {
    const req = makeRequest("POST", "/_sandbox/exec", {
      headers: { authorization: `Bearer ${DAEMON_TOKEN}` },
    });
    expect(
      requireHmacOrToken(req, "/_sandbox/exec", "", {
        linkSecret: LINK_SECRET,
        daemonToken: DAEMON_TOKEN,
        seenNonce: () => false,
      }),
    ).toBeNull();
  });

  it("rejects a request with neither HMAC nor bearer", () => {
    const req = makeRequest("POST", "/_sandbox/exec");
    const result = requireHmacOrToken(req, "/_sandbox/exec", "", {
      linkSecret: LINK_SECRET,
      daemonToken: DAEMON_TOKEN,
      seenNonce: () => false,
    });
    expect(result?.status).toBe(401);
  });

  it("rejects when HMAC headers are present but malformed, even with a valid bearer", async () => {
    const req = makeRequest("POST", "/_sandbox/exec", {
      headers: {
        "X-Mesh-Signature": "garbage",
        authorization: `Bearer ${DAEMON_TOKEN}`,
      },
    });
    // Malformed HMAC is a hard reject — don't silently downgrade.
    const result = requireHmacOrToken(req, "/_sandbox/exec", "", {
      linkSecret: LINK_SECRET,
      daemonToken: DAEMON_TOKEN,
      seenNonce: () => false,
    });
    expect(result?.status).toBe(401);
  });
});
