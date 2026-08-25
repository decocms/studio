import { describe, expect, test } from "bun:test";
import { fetchAuthorizationServerMetadata } from "./oauth-proxy";

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
