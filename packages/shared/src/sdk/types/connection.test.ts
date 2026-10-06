import { describe, expect, it } from "bun:test";
import {
  ConnectionCreateDataSchema,
  ConnectionEntitySchema,
} from "./connection";

function baseEntity(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn_1",
    title: "Test connection",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: "user_1",
    organization_id: "org_1",
    description: null,
    icon: null,
    app_name: null,
    app_id: null,
    connection_type: "HTTP" as const,
    connection_url: "https://example.com",
    connection_token: null,
    connection_headers: null,
    oauth_config: null,
    configuration_state: null,
    configuration_scopes: null,
    metadata: null,
    tools: null,
    bindings: null,
    status: "active" as const,
    ...overrides,
  };
}

describe("ConnectionEntitySchema JSON field caps", () => {
  it("accepts metadata/configuration_state within the size cap", () => {
    const result = ConnectionEntitySchema.safeParse(
      baseEntity({ metadata: { foo: "bar" }, configuration_state: { a: 1 } }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects an oversized metadata blob", () => {
    const huge = { blob: "x".repeat(300 * 1024) };
    const result = ConnectionEntitySchema.safeParse(
      baseEntity({ metadata: huge }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects an oversized configuration_state blob", () => {
    const huge = { blob: "x".repeat(300 * 1024) };
    const result = ConnectionEntitySchema.safeParse(
      baseEntity({ configuration_state: huge }),
    );
    expect(result.success).toBe(false);
  });

  it("still rejects an oversized metadata blob on the create schema", () => {
    const huge = { blob: "x".repeat(300 * 1024) };
    const result = ConnectionCreateDataSchema.safeParse({
      title: "Test",
      connection_type: "HTTP",
      metadata: huge,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a multi-byte blob whose UTF-16 length is under the cap but whose UTF-8 byte size is not", () => {
    // "🚀" is 2 UTF-16 units but 4 UTF-8 bytes — a length check would miss this.
    const huge = { blob: "🚀".repeat(140 * 1024) };
    const result = ConnectionEntitySchema.safeParse(
      baseEntity({ metadata: huge }),
    );
    expect(result.success).toBe(false);
  });
});
