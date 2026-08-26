import { describe, expect, test } from "bun:test";
import {
  assertOriginEndpointIsSafe,
  fetchAuthorizationServerMetadata,
  fetchProtectedResourceMetadata,
} from "./oauth-proxy";

/**
 * `authServerUrl` comes from the origin's own protected-resource-metadata
 * response (`authorization_servers[0]`), not the connection's vetted
 * `connection_url` — a malicious/compromised MCP server can point it at an
 * internal address and get Studio's backend to fetch it server-side.
 */
describe("fetchAuthorizationServerMetadata SSRF guard", () => {
  test("refuses a private/internal auth server URL without making a network call", async () => {
    const response = await fetchAuthorizationServerMetadata(
      "http://169.254.169.254/latest/meta-data/",
    );
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toMatch(/private networks/i);
  });

  test("refuses localhost", async () => {
    const response = await fetchAuthorizationServerMetadata(
      "http://localhost:9999/",
    );
    expect(response.status).toBe(502);
  });
});

/**
 * `authorization_endpoint` / `token_endpoint` / `registration_endpoint`
 * come from the same origin-controlled auth-server metadata document — a
 * malicious/compromised MCP server can point one of these at an internal
 * address and get the proxy to fetch or redirect there server-side,
 * forwarding the caller's Authorization header along with it.
 */
/**
 * `isPrivateUrl` only vets the URL we're about to fetch — a compromised MCP
 * server can 3xx-redirect the metadata fetch anywhere it likes, and fetch
 * follows redirects by default, bypassing that check entirely.
 */
describe("fetchProtectedResourceMetadata redirect SSRF guard", () => {
  test("never follows a redirect to another server", async () => {
    let canaryHit = false;
    const canary = Bun.serve({
      port: 0,
      fetch() {
        canaryHit = true;
        return Response.json({});
      },
    });
    const origin = Bun.serve({
      port: 0,
      fetch() {
        return new Response(null, {
          status: 302,
          headers: { Location: `http://localhost:${canary.port}/` },
        });
      },
    });

    try {
      await expect(
        fetchProtectedResourceMetadata(`http://localhost:${origin.port}`),
      ).rejects.toThrow(/redirect/i);
      expect(canaryHit).toBe(false);
    } finally {
      origin.stop(true);
      canary.stop(true);
    }
  });
});

describe("assertOriginEndpointIsSafe SSRF guard", () => {
  test("refuses a private/internal endpoint URL", () => {
    const response = assertOriginEndpointIsSafe(
      "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    );
    expect(response?.status).toBe(502);
  });

  test("refuses localhost", () => {
    const response = assertOriginEndpointIsSafe("http://localhost:9999/token");
    expect(response?.status).toBe(502);
  });

  test("allows a public endpoint URL", () => {
    const response = assertOriginEndpointIsSafe(
      "https://auth.example.com/token",
    );
    expect(response).toBeNull();
  });
});
