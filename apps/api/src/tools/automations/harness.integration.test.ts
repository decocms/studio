/**
 * Real-Postgres coverage for an automation's harness choice through its
 * tools: the org flag, the required tool list, edits that leave the choice
 * alone, and built-ins.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
// The registry loads first, as on the server: `update.ts` reaches it back
// through `automations/builtin`, so entering at `update.ts` reads
// `AUTOMATION_UPDATE` before it is defined.
import { TOOL_BY_NAME } from "../index";
import { sql } from "kysely";
import { AUTOMATION_HARNESS_FLAG } from "../../automations/run-harness";
import type { StudioContext } from "../../core/studio-context";
import type { StudioDatabase } from "../../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../../database/test-db-pg";
import { createAutomationsStorage } from "../../storage/automations";
import { OrganizationSettingsStorage } from "../../storage/organization-settings";
import { AUTOMATION_CREATE } from "./create";
import { AUTOMATION_GET } from "./get";
import { AUTOMATION_UPDATE } from "./update";

const ORG = "org_test";
const USER = "user_test";
const TOOLS = ["reports_run_due"];

describe("automation harness choice (real Postgres)", () => {
  let database: StudioDatabase;
  let settings: OrganizationSettingsStorage;
  let ctx: StudioContext;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    settings = new OrganizationSettingsStorage(database.db);
    ctx = {
      auth: { user: { id: USER, role: "admin" } },
      organization: { id: ORG, slug: "org-test", name: ORG },
      access: { check: async () => {} },
      storage: {
        automations: createAutomationsStorage(database.db),
        organizationSettings: settings,
      },
    } as unknown as StudioContext;
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("registers the tools it covers", () => {
    for (const tool of [AUTOMATION_CREATE, AUTOMATION_GET, AUTOMATION_UPDATE]) {
      expect(TOOL_BY_NAME.has(tool.name)).toBe(true);
    }
  });

  const setFlag = (on: boolean) =>
    settings.upsert(ORG, { flags: { [AUTOMATION_HARNESS_FLAG]: on } });

  const create = (input: {
    harnessId?: "decopilot" | null;
    tools?: string[] | null;
  }) =>
    AUTOMATION_CREATE.handler(
      {
        name: "alerts",
        virtual_mcp_id: `decopilot_${ORG}`,
        messages: "run the alerts",
        models: { tier: "fast" },
        temperature: 0.5,
        active: true,
        ...input,
      },
      ctx,
    );

  const harnessOf = async (id: string) =>
    (await AUTOMATION_GET.handler({ id }, ctx)).automation?.harnessId;

  it("refuses the choice while the org flag is off", async () => {
    await setFlag(false);
    await expect(
      create({ harnessId: "decopilot", tools: TOOLS }),
    ).rejects.toThrow(AUTOMATION_HARNESS_FLAG);
  });

  it("refuses the choice without a tool list", async () => {
    await setFlag(true);
    for (const tools of [undefined, null, []]) {
      await expect(create({ harnessId: "decopilot", tools })).rejects.toThrow(
        /list of tools/,
      );
    }
  });

  it("stores the choice and reads it back", async () => {
    await setFlag(true);
    const created = await create({ harnessId: "decopilot", tools: TOOLS });
    expect(await harnessOf(created.id)).toBe("decopilot");
  });

  it("creates an automation with no choice whatever the flag says", async () => {
    await setFlag(false);
    const created = await create({ tools: null });
    expect(await harnessOf(created.id)).toBeNull();
  });

  it("refuses an edit that empties the tool list of an automation that chose Decopilot", async () => {
    await setFlag(true);
    const created = await create({ harnessId: "decopilot", tools: TOOLS });
    for (const tools of [null, []]) {
      await expect(
        AUTOMATION_UPDATE.handler({ id: created.id, tools }, ctx),
      ).rejects.toThrow(/list of tools/);
    }
    await AUTOMATION_UPDATE.handler({ id: created.id, name: "renamed" }, ctx);
    expect(await harnessOf(created.id)).toBe("decopilot");
  });

  it("lets the tool list change once the flag is off, since the choice no longer applies", async () => {
    await setFlag(true);
    const created = await create({ harnessId: "decopilot", tools: TOOLS });
    await setFlag(false);
    await AUTOMATION_UPDATE.handler({ id: created.id, tools: null }, ctx);
    expect(await harnessOf(created.id)).toBe("decopilot");
  });

  it("always lets an automation go back to the default", async () => {
    await setFlag(true);
    const created = await create({ harnessId: "decopilot", tools: TOOLS });
    await setFlag(false);
    await AUTOMATION_UPDATE.handler({ id: created.id, harnessId: null }, ctx);
    expect(await harnessOf(created.id)).toBeNull();
  });

  it("chooses Decopilot on an edit that sets the tool list in the same call", async () => {
    await setFlag(true);
    const created = await create({ tools: null });
    await AUTOMATION_UPDATE.handler(
      { id: created.id, harnessId: "decopilot", tools: TOOLS },
      ctx,
    );
    expect(await harnessOf(created.id)).toBe("decopilot");
  });

  it("refuses the choice on a built-in", async () => {
    await setFlag(true);
    const created = await create({ tools: TOOLS });
    await sql`UPDATE automations SET system_key = 'harness_test' WHERE id = ${created.id}`.execute(
      database.db,
    );
    await expect(
      AUTOMATION_UPDATE.handler(
        { id: created.id, harnessId: "decopilot" },
        ctx,
      ),
    ).rejects.toThrow(/Built-in automations/);
  });
});
