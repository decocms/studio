// CredentialVault requires a valid 32-byte base64 ENCRYPTION_KEY.
// Must be set before any import triggers getSettings(), which freezes
// the settings singleton on first access.
process.env.ENCRYPTION_KEY ??= Buffer.from("0".repeat(32)).toString("base64");

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { auth } from "../../auth";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../../database/test-db-pg";
import type { StudioDatabase } from "../../database";
import { CredentialVault } from "../../encryption/credential-vault";
import { setGlobalSettings, getSettings } from "../../settings";
import {
  CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
  CREDENTIAL_CONFIGURATION_READ_SCOPE,
  ConnectionCredentialVaultStorage,
} from "../../storage/connection-credential-vault";
import { DownstreamTokenStorage } from "../../storage/downstream-token";
import { createApp } from "../app";

if (!getSettings().encryptionKey) {
  setGlobalSettings({
    ...getSettings(),
    encryptionKey: process.env.ENCRYPTION_KEY!,
  });
}

describe("Credential Vault Routes", () => {
  let database: StudioDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;
  let workloadToken: string;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);

    vi.spyOn(auth.api, "getMcpSession").mockResolvedValue(null);
    vi.spyOn(auth.api, "verifyApiKey").mockResolvedValue({
      valid: false,
      error: { message: "invalid api key" },
      key: null,
    } as never);

    const now = new Date().toISOString();
    await database.db
      .insertInto("member")
      .values({
        id: "mem_credential_vault_user",
        userId: "user_1",
        organizationId: "org_1",
        role: "member",
        createdAt: now,
      })
      .execute();

    await database.db
      .insertInto("connections")
      .values([
        {
          id: "conn_subject",
          organization_id: "org_1",
          created_by: "user_1",
          title: "Subject Worker",
          connection_type: "HTTP",
          connection_url: "https://worker.example.test/mcp",
          status: "active",
          pinned: false,
          created_at: now,
          updated_at: now,
        },
        {
          id: "conn_target",
          organization_id: "org_1",
          created_by: "user_1",
          title: "Target MCP",
          connection_type: "HTTP",
          connection_url: "https://target.example.test/mcp",
          status: "active",
          pinned: false,
          created_at: now,
          updated_at: now,
        },
        {
          id: "conn_no_grant",
          organization_id: "org_1",
          created_by: "user_1",
          title: "No Grant Target",
          connection_type: "HTTP",
          connection_url: "https://no-grant.example.test/mcp",
          status: "active",
          pinned: false,
          created_at: now,
          updated_at: now,
        },
        {
          id: "conn_configuration_target",
          organization_id: "org_1",
          created_by: "user_1",
          title: "Configuration Target",
          connection_type: "HTTP",
          connection_url: "https://configuration.example.test/mcp",
          configuration_state: await new CredentialVault(
            getSettings().encryptionKey,
          ).encrypt(
            JSON.stringify({
              apiKey: "configuration-secret",
              accountId: "acct_123",
            }),
          ),
          configuration_scopes: JSON.stringify(["self::TOOL"]),
          status: "active",
          pinned: false,
          created_at: now,
          updated_at: now,
        },
        {
          id: "conn_empty_configuration_target",
          organization_id: "org_1",
          created_by: "user_1",
          title: "Empty Configuration Target",
          connection_type: "HTTP",
          connection_url: "https://empty-configuration.example.test/mcp",
          status: "active",
          pinned: false,
          created_at: now,
          updated_at: now,
        },
        {
          id: "conn_invalid_configuration_target",
          organization_id: "org_1",
          created_by: "user_1",
          title: "Invalid Configuration Target",
          connection_type: "HTTP",
          connection_url: "https://invalid-configuration.example.test/mcp",
          configuration_state: "not-valid-ciphertext",
          configuration_scopes: JSON.stringify(["self::TOOL"]),
          status: "active",
          pinned: false,
          created_at: now,
          updated_at: now,
        },
        {
          id: "conn_inactive_granted",
          organization_id: "org_1",
          created_by: "user_1",
          title: "Inactive Granted Target",
          connection_type: "HTTP",
          connection_url: "https://inactive-granted.example.test/mcp",
          status: "inactive",
          pinned: false,
          created_at: now,
          updated_at: now,
        },
        {
          id: "conn_static_token_target",
          organization_id: "org_1",
          created_by: "user_1",
          title: "Static Token Target",
          connection_type: "HTTP",
          connection_url: "https://static-token.example.test/mcp",
          // Token-auth MCP (e.g. Shopify): bearer on the connection only.
          connection_token: await new CredentialVault(
            getSettings().encryptionKey,
          ).encrypt("static-admin-api-token"),
          status: "active",
          pinned: false,
          created_at: now,
          updated_at: now,
        },
        {
          id: "conn_invalid_token_target",
          organization_id: "org_1",
          created_by: "user_1",
          title: "Invalid Token Target",
          connection_type: "HTTP",
          connection_url: "https://invalid-token.example.test/mcp",
          connection_token: "not-valid-ciphertext",
          status: "active",
          pinned: false,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();

    const credentialVaultStorage = new ConnectionCredentialVaultStorage(
      database.db,
    );
    const tokenResult =
      await credentialVaultStorage.createOrRotateWorkloadToken({
        organizationId: "org_1",
        subjectConnectionId: "conn_subject",
        name: "worker",
      });
    workloadToken = tokenResult.plaintextToken;

    await credentialVaultStorage.replaceGrantsForSubject({
      organizationId: "org_1",
      subjectConnectionId: "conn_subject",
      createdBy: "user_1",
      grants: [
        {
          targetConnectionId: "conn_target",
          scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
        },
        {
          targetConnectionId: "conn_inactive_granted",
          scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
        },
        {
          targetConnectionId: "conn_static_token_target",
          scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
        },
        {
          targetConnectionId: "conn_invalid_token_target",
          scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
        },
        {
          targetConnectionId: "conn_inactive_granted",
          scope: CREDENTIAL_CONFIGURATION_READ_SCOPE,
        },
        {
          targetConnectionId: "conn_configuration_target",
          scope: CREDENTIAL_CONFIGURATION_READ_SCOPE,
        },
        {
          targetConnectionId: "conn_empty_configuration_target",
          scope: CREDENTIAL_CONFIGURATION_READ_SCOPE,
        },
        {
          targetConnectionId: "conn_invalid_configuration_target",
          scope: CREDENTIAL_CONFIGURATION_READ_SCOPE,
        },
      ],
    });

    const vault = new CredentialVault(getSettings().encryptionKey);
    const downstreamTokens = new DownstreamTokenStorage(database.db, vault);
    await downstreamTokens.upsert({
      connectionId: "conn_target",
      accessToken: "downstream_access_token",
      refreshToken: "downstream_refresh_token",
      scope: "read write",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      clientId: "client_id",
      clientSecret: "client_secret",
      tokenEndpoint: "https://target.example.test/oauth/token",
    });
    await downstreamTokens.upsert({
      connectionId: "conn_no_grant",
      accessToken: "no_grant_access_token",
      refreshToken: null,
      scope: null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      clientId: null,
      clientSecret: null,
      tokenEndpoint: null,
    });

    app = await createApp({ database, disableNats: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (app) {
      await app.shutdown();
    }
    if (database) {
      await closeTestPgDatabase(database);
    }
  });

  it("exchanges a workload token for a granted downstream OAuth access token", async () => {
    const res = await app.fetch(
      new Request(
        "http://test/api/org_1/vault/connections/conn_target/access-token",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${workloadToken}` },
        },
      ),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Pragma")).toBe("no-cache");
    const body = (await res.json()) as {
      type: string;
      tokenType: string;
      accessToken: string;
      expiresAt: string | null;
      scope: string | null;
    };
    expect(Object.keys(body).sort()).toEqual(
      ["accessToken", "expiresAt", "scope", "tokenType", "type"].sort(),
    );
    expect(body.type).toBe("oauth_access_token");
    expect(body.tokenType).toBe("Bearer");
    expect(body.accessToken).toBe("downstream_access_token");
    expect(body.expiresAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(body.scope).toBe("read write");
  });

  it("falls back to the connection's static bearer token when there is no OAuth token", async () => {
    const res = await app.fetch(
      new Request(
        "http://test/api/org_1/vault/connections/conn_static_token_target/access-token",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${workloadToken}` },
        },
      ),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Pragma")).toBe("no-cache");
    const body = (await res.json()) as {
      type: string;
      tokenType: string;
      accessToken: string;
      expiresAt: string | null;
      scope: string | null;
    };
    expect(Object.keys(body).sort()).toEqual(
      ["accessToken", "expiresAt", "scope", "tokenType", "type"].sort(),
    );
    expect(body.type).toBe("static_token");
    expect(body.tokenType).toBe("Bearer");
    expect(body.accessToken).toBe("static-admin-api-token");
    expect(body.expiresAt).toBeNull();
    expect(body.scope).toBeNull();
  });

  it("exchanges a workload token for a granted downstream MCP configuration", async () => {
    const res = await app.fetch(
      new Request(
        "http://test/api/org_1/vault/connections/conn_configuration_target/configuration",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${workloadToken}` },
        },
      ),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Pragma")).toBe("no-cache");
    const body = (await res.json()) as {
      type: string;
      state: Record<string, unknown>;
      scopes: string[];
    };
    expect(body).toEqual({
      type: "mcp_configuration",
      state: {
        apiKey: "configuration-secret",
        accountId: "acct_123",
      },
      scopes: ["self::TOOL"],
    });
  });

  it("returns empty configuration state and scopes for granted targets without saved configuration", async () => {
    const res = await app.fetch(
      new Request(
        "http://test/api/org_1/vault/connections/conn_empty_configuration_target/configuration",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${workloadToken}` },
        },
      ),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      type: "mcp_configuration",
      state: {},
      scopes: [],
    });
  });

  it("does not allow an access-token grant to read configuration", async () => {
    const res = await app.fetch(
      new Request(
        "http://test/api/org_1/vault/connections/conn_target/configuration",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${workloadToken}` },
        },
      ),
    );

    expect(res.status).toBe(403);
  });

  it("does not allow a configuration grant to read an access token", async () => {
    const res = await app.fetch(
      new Request(
        "http://test/api/org_1/vault/connections/conn_configuration_target/access-token",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${workloadToken}` },
        },
      ),
    );

    expect(res.status).toBe(403);
  });

  it("returns 404 for inactive configuration targets only after a grant exists", async () => {
    const res = await app.fetch(
      new Request(
        "http://test/api/org_1/vault/connections/conn_inactive_granted/configuration",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${workloadToken}` },
        },
      ),
    );

    expect(res.status).toBe(404);
  });

  it("does not return empty configuration when saved configuration cannot be decrypted", async () => {
    const res = await app.fetch(
      new Request(
        "http://test/api/org_1/vault/connections/conn_invalid_configuration_target/configuration",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${workloadToken}` },
        },
      ),
    );

    expect(res.status).toBe(424);
    await expect(res.json()).resolves.toEqual({
      error: "MCP configuration could not be decrypted",
    });
  });

  it("does not report 'not found' when a static connection token cannot be decrypted", async () => {
    const res = await app.fetch(
      new Request(
        "http://test/api/org_1/vault/connections/conn_invalid_token_target/access-token",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${workloadToken}` },
        },
      ),
    );

    expect(res.status).toBe(424);
    await expect(res.json()).resolves.toEqual({
      error: "Connection token could not be decrypted",
    });
  });

  it("rejects access when the subject lacks a grant to the target", async () => {
    const res = await app.fetch(
      new Request(
        "http://test/api/org_1/vault/connections/conn_no_grant/access-token",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${workloadToken}` },
        },
      ),
    );

    expect(res.status).toBe(403);
  });

  it("does not reveal missing targets when the subject lacks a grant", async () => {
    const res = await app.fetch(
      new Request(
        "http://test/api/org_1/vault/connections/conn_missing/access-token",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${workloadToken}` },
        },
      ),
    );

    expect(res.status).toBe(403);
  });

  it("returns 404 for inactive targets only after a grant exists", async () => {
    const res = await app.fetch(
      new Request(
        "http://test/api/org_1/vault/connections/conn_inactive_granted/access-token",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${workloadToken}` },
        },
      ),
    );

    expect(res.status).toBe(404);
  });

  it("rejects requests without a bearer workload token", async () => {
    const res = await app.fetch(
      new Request(
        "http://test/api/org_1/vault/connections/conn_target/access-token",
        { method: "POST" },
      ),
    );

    expect(res.status).toBe(401);
  });

  describe("batch (service token)", () => {
    const prevServiceToken = process.env.VAULT_SERVICE_TOKEN;
    beforeEach(() => {
      process.env.VAULT_SERVICE_TOKEN = "svc-secret";
    });
    afterEach(() => {
      if (prevServiceToken === undefined)
        delete process.env.VAULT_SERVICE_TOKEN;
      else process.env.VAULT_SERVICE_TOKEN = prevServiceToken;
    });

    const batchRequest = (bearer: string, connectionIds: unknown): Request =>
      new Request("http://test/api/org_1/vault/connections/batch", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ connectionIds }),
      });

    it("leases configuration + token for N connections in one round-trip, per-item errors", async () => {
      const res = await app.fetch(
        batchRequest("svc-secret", [
          "conn_target",
          "conn_static_token_target",
          "conn_configuration_target",
          "conn_inactive_granted",
          "conn_does_not_exist",
        ]),
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const body = (await res.json()) as Record<
        string,
        {
          configuration?: { state: Record<string, unknown> };
          accessToken?: { type: string; accessToken: string } | null;
          error?: string;
        }
      >;

      // OAuth connection: valid downstream token comes back as oauth lane.
      expect(body.conn_target?.accessToken?.type).toBe("oauth_access_token");
      expect(body.conn_target?.accessToken?.accessToken).toBe(
        "downstream_access_token",
      );

      // Static-token connection: the connection_token fallback lane.
      expect(body.conn_static_token_target?.accessToken?.type).toBe(
        "static_token",
      );
      expect(body.conn_static_token_target?.accessToken?.accessToken).toBe(
        "static-admin-api-token",
      );

      // Configuration-bearing connection: decrypted state, no token ⇒ null.
      expect(body.conn_configuration_target?.configuration?.state.apiKey).toBe(
        "configuration-secret",
      );
      expect(body.conn_configuration_target?.accessToken).toBeNull();

      // Inactive and unknown connections: per-item error, batch still 200.
      expect(body.conn_inactive_granted?.error).toBe("Connection not found");
      expect(body.conn_does_not_exist?.error).toBe("Connection not found");
    });

    it("does not return empty configuration when saved configuration cannot be decrypted", async () => {
      const res = await app.fetch(
        batchRequest("svc-secret", ["conn_invalid_configuration_target"]),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, { error?: string }>;
      expect(body.conn_invalid_configuration_target?.error).toBe(
        "MCP configuration could not be decrypted",
      );
    });

    it("does not report a null token when a static connection token cannot be decrypted", async () => {
      const res = await app.fetch(
        batchRequest("svc-secret", ["conn_invalid_token_target"]),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, { error?: string }>;
      expect(body.conn_invalid_token_target?.error).toBe(
        "Connection token could not be decrypted",
      );
    });

    it("rejects workload tokens — the batch lane is service-only", async () => {
      const res = await app.fetch(batchRequest(workloadToken, ["conn_target"]));
      expect(res.status).toBe(401);
    });

    it("rejects an empty or non-array connectionIds", async () => {
      expect((await app.fetch(batchRequest("svc-secret", []))).status).toBe(
        400,
      );
      expect(
        (await app.fetch(batchRequest("svc-secret", "conn_target"))).status,
      ).toBe(400);
    });
  });
});
