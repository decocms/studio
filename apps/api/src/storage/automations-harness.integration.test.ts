/**
 * Real-Postgres coverage for `automations.harness_id`: the default, a stored
 * choice, update semantics, the trigger join that fires event automations,
 * and a stored value the code does not know.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../database/test-db-pg";
import { createAutomationsStorage } from "./automations";

const ORG = "org_test";
const USER = "user_test";

describe("automations.harness_id (real Postgres)", () => {
  let database: StudioDatabase;
  let automations: ReturnType<typeof createAutomationsStorage>;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    automations = createAutomationsStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  const make = (name: string, harness_id?: "decopilot" | null) =>
    automations.create({
      organization_id: ORG,
      name,
      created_by: USER,
      messages: "[]",
      models: "{}",
      tools: JSON.stringify(["reports_run_due"]),
      virtual_mcp_id: `decopilot_${ORG}`,
      ...(harness_id !== undefined ? { harness_id } : {}),
    });

  it("keeps the default harness for an automation that chose none", async () => {
    const created = await make("default");
    expect(created.harness_id).toBeNull();
    expect(
      (await automations.findById(created.id, ORG))?.harness_id,
    ).toBeNull();
  });

  it("stores the harness an automation chose", async () => {
    const created = await make("chosen", "decopilot");
    expect(created.harness_id).toBe("decopilot");
    expect((await automations.findById(created.id, ORG))?.harness_id).toBe(
      "decopilot",
    );
  });

  it("keeps the choice on an unrelated update and clears it with null", async () => {
    const created = await make("updated", "decopilot");
    const renamed = await automations.update(created.id, ORG, {
      name: "renamed",
    });
    expect(renamed.harness_id).toBe("decopilot");

    const cleared = await automations.update(created.id, ORG, {
      harness_id: null,
    });
    expect(cleared.harness_id).toBeNull();
  });

  it("carries the choice through the trigger join that fires event automations", async () => {
    const created = await make("event", "decopilot");
    await automations.addTrigger({
      automation_id: created.id,
      type: "event",
      connection_id: "conn_harness",
      event_type: "harness.tested",
    });
    const [fired] = await automations.findActiveEventTriggers(
      "conn_harness",
      "harness.tested",
      ORG,
    );
    expect(fired?.automation.id).toBe(created.id);
    expect(fired?.automation.harness_id).toBe("decopilot");
  });

  it("reads a stored value it does not know as no choice", async () => {
    const created = await make("unknown", "decopilot");
    await sql`UPDATE automations SET harness_id = 'claude-code' WHERE id = ${created.id}`.execute(
      database.db,
    );
    expect(
      (await automations.findById(created.id, ORG))?.harness_id,
    ).toBeNull();
  });
});
