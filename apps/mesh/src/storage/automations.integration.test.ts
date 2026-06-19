import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../database/test-db-pg";
import { createAutomationsStorage } from "./automations";
import type { AutomationsStorage } from "./automations";

const ORG = "org_1";
const USER = "user_1";

describe("AutomationsStorage", () => {
  let database: StudioDatabase;
  let automations: AutomationsStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  beforeEach(async () => {
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    automations = createAutomationsStorage(database.db);
  });

  it("creates automation run threads on message storage v2", async () => {
    const automation = await automations.create({
      organization_id: ORG,
      name: "Grafana alerts",
      created_by: USER,
      messages: "[]",
      models: "{}",
      virtual_mcp_id: "vir_test",
    });

    const threadId = await automations.createAutomationRunThread(
      automation,
      null,
    );

    const row = await database.db
      .selectFrom("threads")
      .select(["message_storage_version", "status", "title"])
      .where("id", "=", threadId)
      .executeTakeFirstOrThrow();

    expect(row.message_storage_version).toBe(2);
    expect(row.status).toBe("in_progress");
    expect(row.title).toBe("Automation: Grafana alerts");
  });
});
