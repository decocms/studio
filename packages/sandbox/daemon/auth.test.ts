import { describe, expect, it } from "bun:test";
import { requireToken } from "./auth";

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

describe("requireToken", () => {
  it("accepts a request with the matching bearer token", () => {
    const req = makeRequest("POST", "/_sandbox/exec", {
      headers: { authorization: `Bearer ${DAEMON_TOKEN}` },
    });
    expect(requireToken(req, DAEMON_TOKEN)).toBeNull();
  });

  it("rejects a request with a non-matching bearer token", () => {
    const req = makeRequest("POST", "/_sandbox/exec", {
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(requireToken(req, DAEMON_TOKEN)?.status).toBe(401);
  });

  it("rejects a request with no authorization header", () => {
    const req = makeRequest("POST", "/_sandbox/exec");
    expect(requireToken(req, DAEMON_TOKEN)?.status).toBe(401);
  });

  it("rejects a non-Bearer authorization header", () => {
    const req = makeRequest("POST", "/_sandbox/exec", {
      headers: { authorization: DAEMON_TOKEN },
    });
    expect(requireToken(req, DAEMON_TOKEN)?.status).toBe(401);
  });

  it("rejects everything when the expected token is empty", () => {
    // A daemon spawned without a token must never accept a blank `Bearer `.
    const req = makeRequest("POST", "/_sandbox/exec", {
      headers: { authorization: "Bearer " },
    });
    expect(requireToken(req, "")?.status).toBe(401);
  });
});
