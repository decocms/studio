import { describe, expect, test } from "bun:test";
import {
  assertOriginEndpointIsSafe,
  fetchAuthorizationServerMetadata,
  fetchProtectedResourceMetadata,
} from "./oauth-proxy";

/**
 * A local listener that records whether anything reached it. Addressed as
 * `localhost.` (trailing dot): it resolves to loopback like `localhost`, so
 * only a guard that resolves DNS or normalizes the name stops it.
 */
function startCanary() {
  let hit = false;
  const server = Bun.serve({
    port: 0,
    fetch() {
      hit = true;
      return Response.json({
        authorization_servers: ["https://auth.example.com"],
        issuer: "https://auth.example.com",
      });
    },
  });
  return {
    url: `http://localhost.:${server.port}`,
    wasHit: () => hit,
    stop: () => server.stop(true),
  };
}

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

  test("refuses a hostname that resolves to loopback without contacting it", async () => {
    const canary = startCanary();
    try {
      const response = await fetchAuthorizationServerMetadata(canary.url);
      expect(response.status).toBe(502);
      expect(canary.wasHit()).toBe(false);
    } finally {
      canary.stop();
    }
  });

  test("fails closed when the hostname cannot be resolved", async () => {
    const response = await fetchAuthorizationServerMetadata(
      "https://auth.unresolvable.invalid/",
    );
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toMatch(/private networks/i);
  });
});

/**
 * The connection URL is caller-supplied and probed from unauthenticated
 * discovery routes, so it gets the same guard as origin-advertised URLs.
 * Refusing it before any fetch also means a redirect from it is never
 * followed; `createNoRedirectFetch` covers redirects from public origins.
 */
describe("fetchProtectedResourceMetadata SSRF guard", () => {
  test("refuses a private connection URL", async () => {
    const response = await fetchProtectedResourceMetadata(
      "http://169.254.169.254/latest/meta-data/",
    );
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toMatch(/private networks/i);
  });

  test("refuses a connection URL whose hostname resolves to loopback without contacting it", async () => {
    const canary = startCanary();
    try {
      const response = await fetchProtectedResourceMetadata(
        `${canary.url}/mcp`,
      );
      expect(response.status).toBe(502);
      expect(canary.wasHit()).toBe(false);
    } finally {
      canary.stop();
    }
  });

  test("refuses a non-http(s) connection URL", async () => {
    const response = await fetchProtectedResourceMetadata("file:///etc/passwd");
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
describe("assertOriginEndpointIsSafe SSRF guard", () => {
  test("refuses a private/internal endpoint URL", async () => {
    const response = await assertOriginEndpointIsSafe(
      "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    );
    expect(response?.status).toBe(502);
  });

  test("refuses localhost", async () => {
    const response = await assertOriginEndpointIsSafe(
      "http://localhost:9999/token",
    );
    expect(response?.status).toBe(502);
  });

  test("refuses a non-http(s) scheme endpoint (file://)", async () => {
    expect((await assertOriginEndpointIsSafe("file:///flag"))?.status).toBe(
      502,
    );
    expect(
      (await assertOriginEndpointIsSafe("file:///etc/passwd"))?.status,
    ).toBe(502);
  });

  test("refuses an endpoint whose hostname cannot be resolved", async () => {
    const response = await assertOriginEndpointIsSafe(
      "https://token.unresolvable.invalid/token",
    );
    expect(response?.status).toBe(502);
  });

  test("allows a public IP-literal endpoint URL", async () => {
    // An IP literal needs no DNS, so this stays offline-deterministic.
    const response = await assertOriginEndpointIsSafe(
      "https://203.0.113.10/token",
    );
    expect(response).toBeNull();
  });
});
