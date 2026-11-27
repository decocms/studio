/**
 * Real-Postgres coverage for the harness a fire picks: the org flag is read
 * from `organization_settings`, and only for an automation that chose one.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { StudioContext } from "../core/studio-context";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../database/test-db-pg";
import { OrganizationSettingsStorage } from "../storage/organization-settings";
import {
  AUTOMATION_HARNESS_FLAG,
  resolveAutomationRunHarness,
} from "./run-harness";

const ORG = "org_test";
const TOOLS = JSON.stringify(["reports_run_due"]);

describe("resolveAutomationRunHarness (real Postgres)", () => {
  let database: StudioDatabase;
  let settings: OrganizationSettingsStorage;
  let ctx: StudioContext;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    settings = new OrganizationSettingsStorage(database.db);
    ctx = {
      storage: { organizationSettings: settings },
    } as unknown as StudioContext;
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  const setFlag = (on: boolean) =>
    settings.upsert(ORG, { flags: { [AUTOMATION_HARNESS_FLAG]: on } });

  it("builds no context for an automation that chose nothing", async () => {
    await setFlag(true);
    const harness = await resolveAutomationRunHarness(
      { organization_id: ORG, harness_id: null, tools: TOOLS },
      {
        sandboxAvailable: true,
        context: async () => {
          throw new Error("the default path must not read settings");
        },
      },
    );
    expect(harness).toBe("claude-code");
  });

  it("runs on Decopilot while the org flag is on", async () => {
    await setFlag(true);
    const harness = await resolveAutomationRunHarness(
      { organization_id: ORG, harness_id: "decopilot", tools: TOOLS },
      { sandboxAvailable: true, context: async () => ctx },
    );
    expect(harness).toBe("decopilot");
  });

  it("goes back to the sandbox once the org turns the flag off", async () => {
    await setFlag(false);
    const harness = await resolveAutomationRunHarness(
      { organization_id: ORG, harness_id: "decopilot", tools: TOOLS },
      { sandboxAvailable: true, context: async () => ctx },
    );
    expect(harness).toBe("claude-code");
  });

  it("keeps the sandbox when the stored tool list is empty", async () => {
    await setFlag(true);
    const harness = await resolveAutomationRunHarness(
      { organization_id: ORG, harness_id: "decopilot", tools: "[]" },
      { sandboxAvailable: true, context: async () => ctx },
    );
    expect(harness).toBe("claude-code");
  });

  it("keeps the sandbox when there is no context to read the flag with", async () => {
    await setFlag(true);
    const harness = await resolveAutomationRunHarness(
      { organization_id: ORG, harness_id: "decopilot", tools: TOOLS },
      { sandboxAvailable: true, context: async () => null },
    );
    expect(harness).toBe("claude-code");
  });
});
