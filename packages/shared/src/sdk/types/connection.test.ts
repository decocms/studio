import { describe, expect, it } from "bun:test";
import {
  ConnectionCreateDataSchema,
  ConnectionEntitySchema,
  ConnectionUpdateDataSchema,
  SECRET_CONFIGURATION_PLACEHOLDER,
  redactSecretConfiguration,
  restoreSecretConfiguration,
  secretFieldsFromStateSchema,
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

  it("rejects an oversized connection_token on the create schema", () => {
    const result = ConnectionCreateDataSchema.safeParse({
      title: "Test",
      connection_type: "HTTP",
      connection_token: "x".repeat(4097),
    });
    expect(result.success).toBe(false);
  });

  it("rejects an oversized connection_token on the update schema", () => {
    const result = ConnectionUpdateDataSchema.safeParse({
      connection_token: "x".repeat(4097),
    });
    expect(result.success).toBe(false);
  });

  it("accepts a connection_token within the size cap on both schemas", () => {
    const token = "x".repeat(4096);
    expect(
      ConnectionCreateDataSchema.safeParse({
        title: "Test",
        connection_type: "HTTP",
        connection_token: token,
      }).success,
    ).toBe(true);
    expect(
      ConnectionUpdateDataSchema.safeParse({ connection_token: token }).success,
    ).toBe(true);
  });
});

describe("secret configuration", () => {
  it("finds format password fields, including nullable unions", () => {
    expect(
      secretFieldsFromStateSchema({
        type: "object",
        properties: {
          accountName: { type: "string" },
          appKey: { type: "string", format: "password" },
          appToken: {
            anyOf: [{ type: "string", format: "password" }, { type: "null" }],
          },
        },
      }),
    ).toEqual(["appKey", "appToken"]);
  });

  it("yields no fields for malformed schemas", () => {
    for (const schema of [null, "x", 1, {}, { properties: null }, []]) {
      expect(secretFieldsFromStateSchema(schema)).toEqual([]);
    }
  });

  it("redacts only set secret values and leaves the input alone", () => {
    const state = { accountName: "store", appKey: "k", appToken: "" };
    expect(redactSecretConfiguration(state, ["appKey", "appToken"])).toEqual({
      accountName: "store",
      appKey: SECRET_CONFIGURATION_PLACEHOLDER,
      appToken: "",
    });
    expect(state.appKey).toBe("k");
    expect(redactSecretConfiguration(state, null)).toBe(state);
    expect(redactSecretConfiguration(null, ["appKey"])).toBeNull();
  });

  it("restores placeholders from the stored state", () => {
    const stored = { appKey: "old-key", appToken: "old-token" };
    expect(
      restoreSecretConfiguration(
        {
          appKey: SECRET_CONFIGURATION_PLACEHOLDER,
          appToken: "new-token",
          missing: SECRET_CONFIGURATION_PLACEHOLDER,
        },
        stored,
      ),
    ).toEqual({ appKey: "old-key", appToken: "new-token" });
    expect(
      restoreSecretConfiguration(
        { appKey: SECRET_CONFIGURATION_PLACEHOLDER },
        null,
      ),
    ).toEqual({});
  });

  it("keeps the secret field list out of create and update input", () => {
    const update = ConnectionUpdateDataSchema.parse({
      configuration_secret_fields: [],
    });
    expect("configuration_secret_fields" in update).toBe(false);
  });
});
