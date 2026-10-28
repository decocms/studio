import { describe, expect, test } from "bun:test";
import { redactConnectionToken } from "./redact";
import { type ConnectionEntity, REDACTED_CONNECTION_TOKEN } from "./schema";

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

describe("redactConnectionToken", () => {
  test("replaces a stored token with the placeholder", () => {
    const redacted = redactConnectionToken(connection("secret-token"));

    expect(redacted.connection_token).toBe(REDACTED_CONNECTION_TOKEN);
    expect(JSON.stringify(redacted)).not.toContain("secret-token");
  });

  test("keeps null so callers can still tell no token is set", () => {
    expect(redactConnectionToken(connection(null)).connection_token).toBeNull();
  });

  test("does not mutate the entity it was given", () => {
    const original = connection("secret-token");
    redactConnectionToken(original);

    expect(original.connection_token).toBe("secret-token");
  });
});
