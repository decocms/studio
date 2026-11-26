import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { WellKnownOrgMCPId } from "@decocms/shared/sdk";
import { checkApiKeyPermission } from "../../auth/api-key-permissions";
import {
  getCachedBuiltinRoleStatements,
  resolveBuiltinRolePermission,
} from "../../auth/builtin-role-permission";
import { AccessControl } from "../../core/access-control";
import type { BoundAuthClient, StudioContext } from "../../core/studio-context";
import type { StudioDatabase } from "../../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../../database/test-db-pg";
import { CredentialVault } from "../../encryption/credential-vault";
import { getSettings, setGlobalSettings } from "../../settings";
import { ConnectionStorage } from "../../storage/connection";
import { ConnectionCredentialVaultStorage } from "../../storage/connection-credential-vault";
import { planBigQueryBinding } from "../../plan-engine/adapters/bigquery";
import { OrganizationSettingsStorage } from "../../storage/organization-settings";
import { PlanEngineStorage } from "../../storage/plan-engine";
import type { Permission } from "../../storage/types";
import { PLAN_DIAGNOSIS_SETUP, PLAN_DIAGNOSIS_STATUS } from "./index";

const ORG_ID = "org_123";
const OTHER_ORG_ID = "org_456";
const USER_ID = "user_1";
const ENGINE_URL = "https://plan-diagnosis.example.com/mcp";
const BIGQUERY_ID = "conn_bigquery_own";
const FOREIGN_BIGQUERY_ID = "conn_bigquery_foreign";

type Principal =
  | { kind: "member"; role: string }
  | { kind: "apiKey"; allowlist: Permission };

/** A bound auth that answers the way the real one does for each principal. */
function boundAuthFor(principal: Principal): BoundAuthClient {
  return {
    isApiKeyPrincipal: principal.kind === "apiKey",
    hasPermission: async (requested: Permission) =>
      principal.kind === "apiKey"
        ? checkApiKeyPermission(principal.allowlist, requested)
        : resolveBuiltinRolePermission(
            principal.role,
            requested,
            getCachedBuiltinRoleStatements(),
          ) === "grant",
  } as unknown as BoundAuthClient;
}

describe("PLAN_DIAGNOSIS tools", () => {
  let database: StudioDatabase;
  let connections: ConnectionStorage;
  let connectionCredentialVault: ConnectionCredentialVaultStorage;
  let organizationSettings: OrganizationSettingsStorage;
  let planEngine: PlanEngineStorage;
  const originalSettings = getSettings();
  const engineCalls: Array<{ name: string; arguments: unknown }> = [];

  function setEngineUrl(url: string | undefined) {
    setGlobalSettings({ ...originalSettings, planDiagnosisMcpUrl: url });
  }

  function makeCtx(
    toolName: string,
    principal: Principal = { kind: "member", role: "user" },
    orgId = ORG_ID,
  ): StudioContext {
    const role = principal.kind === "member" ? principal.role : undefined;
    return {
      auth: {
        user: {
          id: USER_ID,
          email: "member@example.com",
          name: "Member",
          role: "user",
        },
      },
      organization: { id: orgId, slug: orgId, name: orgId },
      access: new AccessControl(
        USER_ID,
        toolName,
        boundAuthFor(principal),
        role,
        "self",
        undefined,
        orgId,
      ),
      storage: {
        connections,
        connectionCredentialVault,
        organizationSettings,
        planEngine,
      },
      baseUrl: "https://studio.example.com",
      metadata: { requestId: "req_1", timestamp: new Date() },
      // The engine is the infrastructure edge: record what Studio tells it.
      getOrCreateClient: async () => ({
        callTool: async (call: { name: string; arguments: unknown }) => {
          engineCalls.push(call);
          return { content: [] };
        },
      }),
    } as unknown as StudioContext;
  }

  const setup = (
    input: {
      bigquery_connection_id: string;
      bigquery_project_id: string;
      bigquery_dataset_id: string;
    },
    principal?: Principal,
  ) =>
    PLAN_DIAGNOSIS_SETUP.handler(
      input,
      makeCtx("PLAN_DIAGNOSIS_SETUP", principal),
    );

  const status = (principal?: Principal) =>
    PLAN_DIAGNOSIS_STATUS.handler(
      {},
      makeCtx("PLAN_DIAGNOSIS_STATUS", principal),
    );

  const validInput = {
    bigquery_connection_id: BIGQUERY_ID,
    bigquery_project_id: "analytics-project",
    bigquery_dataset_id: "analytics_123",
  };

  async function createBigQueryConnection(id: string, orgId: string) {
    await connections.create({
      id,
      organization_id: orgId,
      created_by: USER_ID,
      title: "BigQuery",
      connection_type: "HTTP",
      connection_url: "https://bigquery.invalid/mcp",
      connection_token: null,
      tools: null,
    });
  }

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    const vault = new CredentialVault(CredentialVault.generateKey());
    connections = new ConnectionStorage(database.db, vault);
    connectionCredentialVault = new ConnectionCredentialVaultStorage(
      database.db,
    );
    organizationSettings = new OrganizationSettingsStorage(database.db);
    planEngine = new PlanEngineStorage(database.db);
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
  });

  beforeEach(async () => {
    for (const id of [
      WellKnownOrgMCPId.PLAN_DIAGNOSIS(ORG_ID),
      BIGQUERY_ID,
      FOREIGN_BIGQUERY_ID,
    ]) {
      await connections.delete(id);
    }
    await organizationSettings.upsert(ORG_ID, {
      flags: { plan_page_enabled: true, plan_engine_native: false },
    });
    await createBigQueryConnection(BIGQUERY_ID, ORG_ID);
    await createBigQueryConnection(FOREIGN_BIGQUERY_ID, OTHER_ORG_ID);
    setEngineUrl(ENGINE_URL);
    engineCalls.length = 0;
  });

  afterAll(async () => {
    setGlobalSettings(originalSettings);
    await closeTestPgDatabase(database);
  });

  it("creates the well-known connection with the BigQuery binding", async () => {
    expect(await status()).toEqual({
      configured: false,
      connection_id: null,
      reason: "not_connected",
    });

    const result = await setup(validInput);

    const id = WellKnownOrgMCPId.PLAN_DIAGNOSIS(ORG_ID);
    expect(result).toEqual({ connection_id: id });
    const row = await connections.findById(id, ORG_ID);
    expect(row?.connection_url).toBe(ENGINE_URL);
    expect(row?.app_name).toBe("plan-diagnosis");
    expect(row?.configuration_state).toEqual({
      BIGQUERY: { __type: "google-big-query", value: BIGQUERY_ID },
      bigqueryProjectId: "analytics-project",
      bigqueryDatasetId: "analytics_123",
      SELF: { value: `${ORG_ID}_self` },
    });
    expect(row?.configuration_scopes).toEqual([
      "BIGQUERY::*",
      "SELF::CUSTOMER_LAKE_QUERY",
      "SELF::ORGANIZATION_GET",
      "SELF::COLLECTION_CONNECTIONS_GET",
      "SELF::COLLECTION_VIRTUAL_MCP_LIST",
    ]);
    expect(engineCalls).toHaveLength(1);
    expect(engineCalls[0]).toMatchObject({
      name: "ON_MCP_CONFIGURATION",
      arguments: { state: row?.configuration_state, firstRun: true },
    });

    expect(await status()).toEqual({ configured: true, connection_id: id });
  });

  it("second setup updates instead of duplicating", async () => {
    await setup(validInput);
    // A field set on the connection outside this setup survives it.
    const id = WellKnownOrgMCPId.PLAN_DIAGNOSIS(ORG_ID);
    const first = await connections.findById(id, ORG_ID);
    await connections.update(id, {
      configuration_state: {
        ...first?.configuration_state,
        openrouterModel: "kept",
      },
    });

    await setup({ ...validInput, bigquery_dataset_id: "analytics_456" });

    const { items } = await connections.list(ORG_ID, {
      where: { field: ["connection_url"], operator: "eq", value: ENGINE_URL },
    });
    expect(items.map((c) => c.id)).toEqual([id]);
    expect(items[0]?.configuration_state).toMatchObject({
      bigqueryDatasetId: "analytics_456",
      openrouterModel: "kept",
    });
    expect(engineCalls.map((c) => c.arguments)).toMatchObject([
      { firstRun: true },
      { firstRun: false, state: { bigqueryDatasetId: "analytics_456" } },
    ]);
  });

  it("refuses when plan_page_enabled is off", async () => {
    await organizationSettings.upsert(ORG_ID, {
      flags: { plan_page_enabled: false },
    });

    await expect(setup(validInput)).rejects.toThrow(/^flag_off/);
    expect(await status()).toEqual({
      configured: false,
      connection_id: null,
      reason: "flag_off",
    });
    expect(
      await connections.findById(
        WellKnownOrgMCPId.PLAN_DIAGNOSIS(ORG_ID),
        ORG_ID,
      ),
    ).toBeNull();
  });

  it("refuses without org write access", async () => {
    // A key that may read the status, and nothing else.
    const readOnlyKey: Principal = {
      kind: "apiKey",
      allowlist: { self: ["PLAN_DIAGNOSIS_STATUS"] },
    };

    await expect(setup(validInput, readOnlyKey)).rejects.toThrow(
      /Access denied/,
    );
    expect(await status(readOnlyKey)).toMatchObject({ configured: false });
    expect(
      await connections.findById(
        WellKnownOrgMCPId.PLAN_DIAGNOSIS(ORG_ID),
        ORG_ID,
      ),
    ).toBeNull();
  });

  it("status reports service_unset without the env", async () => {
    setEngineUrl(undefined);

    expect(await status()).toEqual({
      configured: false,
      connection_id: null,
      reason: "service_unset",
    });
    await expect(setup(validInput)).rejects.toThrow(/^service_unset/);
  });

  it("treats a malformed engine URL as unset", async () => {
    setEngineUrl("not a url");

    expect(await status()).toMatchObject({ reason: "service_unset" });
  });

  it("bigquery_connection_id of another org is refused", async () => {
    await expect(
      setup({ ...validInput, bigquery_connection_id: FOREIGN_BIGQUERY_ID }),
    ).rejects.toThrow(/not found/);
    expect(
      await connections.findById(
        WellKnownOrgMCPId.PLAN_DIAGNOSIS(ORG_ID),
        ORG_ID,
      ),
    ).toBeNull();
    expect(engineCalls).toHaveLength(0);
  });

  it("status reports not_connected once the bound BigQuery connection is gone", async () => {
    await setup(validInput);
    await connections.delete(BIGQUERY_ID);

    expect(await status()).toEqual({
      configured: false,
      connection_id: WellKnownOrgMCPId.PLAN_DIAGNOSIS(ORG_ID),
      reason: "not_connected",
    });
  });

  describe("with plan_engine_native on", () => {
    const enableNative = () =>
      organizationSettings.upsert(ORG_ID, {
        flags: { plan_page_enabled: true, plan_engine_native: true },
      });
    const binding = () =>
      planBigQueryBinding(makeCtx("PLAN_DIAGNOSIS_STATUS"), ORG_ID);

    beforeEach(enableNative);

    it("needs no diagnosis service: setup saves the binding for Studio's engine and creates no connection", async () => {
      setEngineUrl(undefined);
      expect(await status()).toEqual({
        configured: false,
        connection_id: null,
        reason: "not_connected",
      });

      expect(await setup(validInput)).toEqual({ connection_id: null });

      expect(await status()).toEqual({ configured: true, connection_id: null });
      expect(await binding()).toEqual({
        connectionId: BIGQUERY_ID,
        projectId: "analytics-project",
        datasetId: "analytics_123",
      });
      expect(
        await connections.findById(
          WellKnownOrgMCPId.PLAN_DIAGNOSIS(ORG_ID),
          ORG_ID,
        ),
      ).toBeNull();
      expect(engineCalls).toHaveLength(0);
    });

    it("a second setup replaces the binding", async () => {
      await setup(validInput);
      await setup({ ...validInput, bigquery_dataset_id: "analytics_456" });
      expect(await binding()).toMatchObject({ datasetId: "analytics_456" });
    });

    it("an org set up on the external engine is configured without redoing it", async () => {
      await organizationSettings.upsert(ORG_ID, {
        flags: { plan_engine_native: false },
      });
      await setup(validInput);
      await enableNative();

      expect(await status()).toEqual({ configured: true, connection_id: null });
      expect(await binding()).toEqual({
        connectionId: BIGQUERY_ID,
        projectId: "analytics-project",
        datasetId: "analytics_123",
      });

      // Once set up for Studio's engine, its own binding wins.
      await setup({ ...validInput, bigquery_dataset_id: "analytics_native" });
      expect(await binding()).toMatchObject({ datasetId: "analytics_native" });
    });

    it("refuses another org's BigQuery connection and saves nothing", async () => {
      await expect(
        setup({ ...validInput, bigquery_connection_id: FOREIGN_BIGQUERY_ID }),
      ).rejects.toThrow(/not found/);
      expect(await binding()).toBeNull();
    });

    it("is not connected once the bound BigQuery connection is gone", async () => {
      await setup(validInput);
      await connections.delete(BIGQUERY_ID);
      expect(await status()).toEqual({
        configured: false,
        connection_id: null,
        reason: "not_connected",
      });
      expect(await binding()).toBeNull();
    });

    it("still answers flag_off with the Plan page off", async () => {
      await organizationSettings.upsert(ORG_ID, {
        flags: { plan_page_enabled: false, plan_engine_native: true },
      });
      expect(await status()).toMatchObject({ reason: "flag_off" });
      await expect(setup(validInput)).rejects.toThrow(/^flag_off/);
    });
  });
});
