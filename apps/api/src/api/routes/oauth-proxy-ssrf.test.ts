import { describe, expect, test } from "bun:test";
import {
  assertOriginEndpointIsSafe,
  fetchAuthorizationServerMetadata,
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
