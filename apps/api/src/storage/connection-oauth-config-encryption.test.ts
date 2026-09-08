import { describe, expect, it } from "bun:test";
import type { Kysely } from "kysely";
import { CredentialVault } from "../encryption/credential-vault";
import { ConnectionStorage } from "./connection";
import type { Database } from "./types";

describe("ConnectionStorage oauth_config encryption", () => {
  const vault = new CredentialVault("test-encryption-key-for-unit-tests");
  const storage = new ConnectionStorage({} as Kysely<Database>, vault);
  const oauthConfig = {
    authorizationEndpoint: "https://example.com/authorize",
    tokenEndpoint: "https://example.com/token",
    clientId: "client-id",
    clientSecret: "super-secret",
    scopes: ["read"],
    grantType: "authorization_code" as const,
  };

  it("encrypts oauth_config at rest instead of storing it as plain JSON", async () => {
    const serialized = await (
      storage as unknown as {
        serializeConnection: (
          data: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      }
    ).serializeConnection({ oauth_config: oauthConfig });

    const stored = serialized.oauth_config as string;
    expect(stored).not.toContain("super-secret");
    expect(() => JSON.parse(stored)).toThrow();
  });

  it("round-trips a freshly encrypted oauth_config on read", async () => {
    const serialized = await (
      storage as unknown as {
        serializeConnection: (
          data: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      }
    ).serializeConnection({ oauth_config: oauthConfig });

    const deserialized = await (
      storage as unknown as {
        deserializeConnection: (
          row: Record<string, unknown>,
        ) => Promise<{ oauth_config: unknown }>;
      }
    ).deserializeConnection({
      id: "conn_test",
      organization_id: "org_test",
      connection_type: "HTTP",
      oauth_config: serialized.oauth_config,
    });

    expect(deserialized.oauth_config).toEqual(oauthConfig);
  });

  it("falls back to plain JSON for a legacy unencrypted row", async () => {
    const legacyRow = JSON.stringify(oauthConfig);

    const deserialized = await (
      storage as unknown as {
        deserializeConnection: (
          row: Record<string, unknown>,
        ) => Promise<{ oauth_config: unknown }>;
      }
    ).deserializeConnection({
      id: "conn_legacy",
      organization_id: "org_test",
      connection_type: "HTTP",
      oauth_config: legacyRow,
    });

    expect(deserialized.oauth_config).toEqual(oauthConfig);
  });
});
