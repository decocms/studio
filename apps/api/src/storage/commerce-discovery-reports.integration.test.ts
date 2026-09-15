import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getWellKnownCommerceDiscoveryConnection } from "@decocms/shared/sdk";
import { delay } from "@decocms/shared/std";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../database/test-db-pg";
import { CredentialVault } from "../encryption/credential-vault";
import { CommerceDiscoveryReportStorage } from "./commerce-discovery-reports";
import { ConnectionStorage } from "./connection";

const ORG = "org_123";
const USER = "user_123";
const CONNECTION_ID = `${ORG}_commerce-discovery`;

describe("CommerceDiscoveryReportStorage (real Postgres)", () => {
  let database: StudioDatabase;
  let vault: CredentialVault;
  let reports: CommerceDiscoveryReportStorage;
  let connections: ConnectionStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    vault = new CredentialVault(CredentialVault.generateKey());
    reports = new CommerceDiscoveryReportStorage(database.db, vault);
    connections = new ConnectionStorage(database.db, vault);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("keeps a run's first site and project snapshot immutable", async () => {
    const ownership = {
      organizationId: ORG,
      runId: "run_immutable",
      siteUrl: "https://first.example",
      virtualMcpId: "vir_first",
    };
    await reports.recordRun(ownership);
    await reports.recordRun(ownership);

    await expect(
      reports.recordRun({
        ...ownership,
        siteUrl: "https://second.example",
        virtualMcpId: "vir_second",
      }),
    ).rejects.toThrow("Commerce Discovery run ownership conflict");
    expect(await reports.findRun(ORG, ownership.runId)).toEqual(ownership);
    expect(await reports.findRun("org_456", ownership.runId)).toBeNull();
  });

  it("serializes token minting with the matching site and owner write", async () => {
    await connections.create({
      ...getWellKnownCommerceDiscoveryConnection(
        ORG,
        "token_old",
        "https://reports.example/mcp",
      ),
      organization_id: ORG,
      created_by: USER,
      metadata: {
        siteUrl: "https://old.example",
        projectId: "vir_old",
      },
    });

    const releaseFirst = Promise.withResolvers<void>();
    const firstEntered = Promise.withResolvers<void>();
    const secondEntered = Promise.withResolvers<void>();
    let newestMintedToken = "token_old";

    const setup = (
      name: "first" | "second",
      siteUrl: string,
      projectId: string,
    ) =>
      reports.withSetupLock(ORG, async ({ connections: locked }) => {
        if (name === "first") firstEntered.resolve();
        else secondEntered.resolve();
        const current = await locked.findById(CONNECTION_ID, ORG);
        if (!current) throw new Error("missing report connection");
        await locked.update(CONNECTION_ID, { connection_token: null });
        if (name === "first") await releaseFirst.promise;

        newestMintedToken = `token_${name}`;
        await locked.update(CONNECTION_ID, {
          connection_token: newestMintedToken,
          metadata: { siteUrl, projectId },
        });
      });

    const first = setup("first", "https://first.example", "vir_first");
    await firstEntered.promise;
    const second = setup("second", "https://second.example", "vir_second");

    const secondState = await Promise.race([
      secondEntered.promise.then(() => "entered" as const),
      delay(50).then(() => "blocked" as const),
    ]);
    expect(secondState).toBe("blocked");
    releaseFirst.resolve();
    await Promise.all([first, second]);

    const persisted = await connections.findById(CONNECTION_ID, ORG);
    expect(persisted?.connection_token).toBe(newestMintedToken);
    expect(persisted?.connection_token).toBe("token_second");
    expect(persisted?.metadata).toMatchObject({
      siteUrl: "https://second.example",
      projectId: "vir_second",
    });
  });

  it("leaves no stale credential when a claim fails after revocation", async () => {
    await expect(
      reports.withSetupLock(ORG, async ({ connections: locked }) => {
        await locked.update(CONNECTION_ID, { connection_token: null });
        throw new Error("upstream claim failed");
      }),
    ).rejects.toThrow("upstream claim failed");

    const persisted = await connections.findById(CONNECTION_ID, ORG);
    expect(persisted?.connection_token).toBeNull();
  });
});
