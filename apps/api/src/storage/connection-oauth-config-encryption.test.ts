import { describe, expect, it } from "bun:test";
import type { Kysely } from "kysely";
import { CredentialVault } from "../encryption/credential-vault";
import { ConnectionStorage } from "./connection";
import { recordDecryptFailure } from "./decrypt-failure-tracker";
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

  it("feeds an undecryptable, non-JSON oauth_config into the same failure tracker as connection_token", async () => {
    const connectionId = "conn_corrupt_oauth";
    const before = recordDecryptFailure(connectionId).consecutiveFailures;

    const deserialized = await (
      storage as unknown as {
        deserializeConnection: (
          row: Record<string, unknown>,
        ) => Promise<{ oauth_config: unknown }>;
      }
    ).deserializeConnection({
      id: connectionId,
      organization_id: "org_test",
      connection_type: "HTTP",
      status: "active",
      oauth_config: "not-ciphertext-and-not-json",
    });

    expect(deserialized.oauth_config).toBeNull();
    // A real decrypt failure must reach the same tracker as connection_token.
    expect(recordDecryptFailure(connectionId).consecutiveFailures).toBe(
      before + 2,
    );
  });

  it("feeds an undecryptable STDIO envVar into the same failure tracker as connection_token", async () => {
    const connectionId = "conn_corrupt_envvar";
    const before = recordDecryptFailure(connectionId).consecutiveFailures;

    const deserialized = await (
      storage as unknown as {
        deserializeConnection: (row: Record<string, unknown>) => Promise<{
          connection_headers: { envVars?: Record<string, string> } | null;
        }>;
      }
    ).deserializeConnection({
      id: connectionId,
      organization_id: "org_test",
      connection_type: "STDIO",
      status: "active",
      connection_headers: JSON.stringify({
        command: "npx",
        envVars: { API_KEY: "not-ciphertext" },
      }),
    });

    expect(deserialized.connection_headers?.envVars?.API_KEY).toBe("");
    // Never leak ciphertext into the spawned process's env.
    expect(recordDecryptFailure(connectionId).consecutiveFailures).toBe(
      before + 2,
    );
  });
});
