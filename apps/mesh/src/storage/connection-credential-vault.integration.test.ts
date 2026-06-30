import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../database/test-db-pg";
import type { StudioDatabase } from "../database";
import {
  CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
  ConnectionCredentialVaultStorage,
} from "./connection-credential-vault";

describe("ConnectionCredentialVaultStorage", () => {
  let database: StudioDatabase;
  let storage: ConnectionCredentialVaultStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);

    const now = new Date().toISOString();
    await sql`
      INSERT INTO "organization" (id, name, slug, "createdAt")
      VALUES ('org_other', 'org_other', 'org_other', ${now})
      ON CONFLICT (id) DO NOTHING
    `.execute(database.db);

    for (const [connId, orgId] of [
      ["conn_subject", "org_test"],
      ["conn_target", "org_test"],
      ["conn_rotate_subject", "org_test"],
      ["conn_revoke_subject", "org_test"],
      ["conn_grant_subject", "org_test"],
      ["conn_grant_target_old", "org_test"],
      ["conn_grant_target_new", "org_test"],
      ["conn_preserve_subject", "org_test"],
      ["conn_preserve_target", "org_test"],
      ["conn_other_subject", "org_other"],
      ["conn_other_target", "org_other"],
    ] as const) {
      await sql`
        INSERT INTO connections (id, organization_id, created_by, title, connection_type, connection_url, status, created_at, updated_at)
        VALUES (${connId}, ${orgId}, 'user_test', ${connId}, 'HTTP', 'https://test.com', 'active', ${now}, ${now})
        ON CONFLICT (id) DO NOTHING
      `.execute(database.db);
    }

    storage = new ConnectionCredentialVaultStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("creates a workload token and authenticates it to the subject and org", async () => {
    const { plaintextToken, record } =
      await storage.createOrRotateWorkloadToken({
        organizationId: "org_test",
        subjectConnectionId: "conn_subject",
        name: "primary",
      });

    expect(plaintextToken).toStartWith("stv_");
    expect(record.id).toStartWith("cwt_");
    expect(record.organizationId).toBe("org_test");
    expect(record.subjectConnectionId).toBe("conn_subject");
    expect(record.name).toBe("primary");
    expect(record.revokedAt).toBeNull();

    const auth = await storage.authenticateWorkloadToken(plaintextToken);
    expect(auth).toEqual({
      tokenId: record.id,
      tokenPrefix: record.tokenPrefix,
      organizationId: "org_test",
      subjectConnectionId: "conn_subject",
    });
  });

  it("rotates the same org subject and name by revoking the old token", async () => {
    const first = await storage.createOrRotateWorkloadToken({
      organizationId: "org_test",
      subjectConnectionId: "conn_rotate_subject",
      name: "deploy",
    });
    const second = await storage.createOrRotateWorkloadToken({
      organizationId: "org_test",
      subjectConnectionId: "conn_rotate_subject",
      name: "deploy",
    });

    expect(second.record.id).not.toBe(first.record.id);
    expect(
      await storage.authenticateWorkloadToken(first.plaintextToken),
    ).toBeNull();
    expect(
      await storage.authenticateWorkloadToken(second.plaintextToken),
    ).toEqual({
      tokenId: second.record.id,
      tokenPrefix: second.record.tokenPrefix,
      organizationId: "org_test",
      subjectConnectionId: "conn_rotate_subject",
    });
  });

  it("finds and revokes an active workload token without exposing plaintext", async () => {
    const created = await storage.createOrRotateWorkloadToken({
      organizationId: "org_test",
      subjectConnectionId: "conn_revoke_subject",
      name: "deploy",
    });

    const active = await storage.findActiveWorkloadToken({
      organizationId: "org_test",
      subjectConnectionId: "conn_revoke_subject",
      name: "deploy",
    });
    expect(active?.id).toBe(created.record.id);
    expect(active?.tokenHash).toBe(created.record.tokenHash);

    await storage.revokeWorkloadToken({
      organizationId: "org_test",
      subjectConnectionId: "conn_revoke_subject",
      tokenId: created.record.id,
    });

    await expect(
      storage.authenticateWorkloadToken(created.plaintextToken),
    ).resolves.toBeNull();
    await expect(
      storage.findActiveWorkloadToken({
        organizationId: "org_test",
        subjectConnectionId: "conn_revoke_subject",
        name: "deploy",
      }),
    ).resolves.toBeNull();
  });

  it("rejects workload token creation for a subject outside the organization", async () => {
    await expect(
      storage.createOrRotateWorkloadToken({
        organizationId: "org_test",
        subjectConnectionId: "conn_other_subject",
        name: "cross-org",
      }),
    ).rejects.toThrow("Subject connection not found in organization");
  });

  it("replaces subject grants by removing stale grants and keeping current grants", async () => {
    await storage.replaceGrantsForSubject({
      organizationId: "org_test",
      subjectConnectionId: "conn_grant_subject",
      createdBy: "user_test",
      grants: [
        {
          targetConnectionId: "conn_grant_target_old",
          scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
        },
      ],
    });

    await storage.replaceGrantsForSubject({
      organizationId: "org_test",
      subjectConnectionId: "conn_grant_subject",
      createdBy: "user_test",
      grants: [
        {
          targetConnectionId: "conn_grant_target_new",
          scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
        },
      ],
    });

    expect(
      await storage.hasGrant({
        organizationId: "org_test",
        subjectConnectionId: "conn_grant_subject",
        targetConnectionId: "conn_grant_target_old",
        scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
      }),
    ).toBe(false);
    expect(
      await storage.hasGrant({
        organizationId: "org_test",
        subjectConnectionId: "conn_grant_subject",
        targetConnectionId: "conn_grant_target_new",
        scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
      }),
    ).toBe(true);

    const rows = await database.db
      .selectFrom("connection_credential_grants")
      .select(["target_connection_id", "scope"])
      .where("organization_id", "=", "org_test")
      .where("subject_connection_id", "=", "conn_grant_subject")
      .execute();

    expect(rows).toEqual([
      {
        target_connection_id: "conn_grant_target_new",
        scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
      },
    ]);
  });

  it("checks grants within organization scope only", async () => {
    await storage.replaceGrantsForSubject({
      organizationId: "org_other",
      subjectConnectionId: "conn_other_subject",
      createdBy: "user_test",
      grants: [
        {
          targetConnectionId: "conn_other_target",
          scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
        },
      ],
    });

    expect(
      await storage.hasGrant({
        organizationId: "org_test",
        subjectConnectionId: "conn_other_subject",
        targetConnectionId: "conn_other_target",
        scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
      }),
    ).toBe(false);
    expect(
      await storage.hasGrant({
        organizationId: "org_other",
        subjectConnectionId: "conn_other_subject",
        targetConnectionId: "conn_other_target",
        scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
      }),
    ).toBe(true);
  });

  it("rejects grant replacement for a target outside the organization without deleting existing grants", async () => {
    await storage.replaceGrantsForSubject({
      organizationId: "org_test",
      subjectConnectionId: "conn_preserve_subject",
      createdBy: "user_test",
      grants: [
        {
          targetConnectionId: "conn_preserve_target",
          scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
        },
      ],
    });

    await expect(
      storage.replaceGrantsForSubject({
        organizationId: "org_test",
        subjectConnectionId: "conn_preserve_subject",
        createdBy: "user_test",
        grants: [
          {
            targetConnectionId: "conn_other_target",
            scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
          },
        ],
      }),
    ).rejects.toThrow("Referenced connection not found in organization");

    expect(
      await storage.hasGrant({
        organizationId: "org_test",
        subjectConnectionId: "conn_preserve_subject",
        targetConnectionId: "conn_preserve_target",
        scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
      }),
    ).toBe(true);
  });
});
