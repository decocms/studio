import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { StudioContext } from "../../core/studio-context";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../../database/test-db-pg";
import type { StudioDatabase } from "../../database";
import { VirtualMCPStorage } from "../../storage/virtual";
import { OrganizationSettingsStorage } from "../../storage/organization-settings";
import { defaultHomeAgentNextActions } from "./home-next-actions";

describe("defaultHomeAgentNextActions — cross-org id", () => {
  let database: StudioDatabase;
  let ctx: StudioContext;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);

    const now = new Date().toISOString();
    await database.db
      .insertInto("connections")
      .values({
        id: "conn_foreign_agent",
        organization_id: "org_123",
        created_by: "user_123",
        updated_by: null,
        title: "Org 123's Agent",
        description: null,
        icon: null,
        app_name: null,
        app_id: null,
        slug: null,
        connection_type: "VIRTUAL",
        connection_url: "virtual://conn_foreign_agent",
        connection_token: null,
        connection_headers: null,
        oauth_config: null,
        configuration_state: null,
        configuration_scopes: null,
        metadata: null,
        bindings: null,
        status: "active",
        pinned: false,
        created_at: now,
        updated_at: now,
      })
      .execute();

    const settings = new OrganizationSettingsStorage(database.db);
    // Stands in for a stale/foreign id in org_1's own settings row.
    await settings.upsert("org_1", {
      default_home_agents: { ids: ["conn_foreign_agent"] },
    });

    ctx = {
      storage: {
        virtualMcps: new VirtualMCPStorage(database.db),
        organizationSettings: settings,
      },
    } as unknown as StudioContext;
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("does not surface an agent id owned by a different org", async () => {
    const result = await defaultHomeAgentNextActions("org_1", ctx, new Set());
    expect(result.prompts).toEqual([]);
    expect(result.tiles).toEqual([]);
  });
});
