import { describe, expect, test } from "bun:test";
import { toPublicConnection } from "./public-connection";
import type { ConnectionEntity } from "./schema";

const connection = (token: string | null): ConnectionEntity => ({
  id: "conn_1",
  title: "Store",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  created_by: "user_1",
  organization_id: "org_1",
  description: null,
  icon: null,
  app_name: null,
  app_id: null,
  connection_type: "HTTP",
  connection_url: "https://example.com/mcp",
  connection_token: token,
  connection_headers: null,
  oauth_config: null,
  configuration_state: null,
  metadata: null,
  tools: null,
  bindings: null,
  status: "active",
});

describe("toPublicConnection", () => {
  test("drops a stored token and reports that one is set", () => {
    const result = toPublicConnection(connection("secret-token"));

    expect("connection_token" in result).toBe(false);
    expect(result.has_connection_token).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  test("reports no token when none is stored", () => {
    const result = toPublicConnection(connection(null));

    expect("connection_token" in result).toBe(false);
    expect(result.has_connection_token).toBe(false);
  });

  test("does not mutate the entity it was given", () => {
    const original = connection("secret-token");
    toPublicConnection(original);

    expect(original.connection_token).toBe("secret-token");
  });
});
