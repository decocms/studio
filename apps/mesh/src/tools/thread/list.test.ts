import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { COLLECTION_THREADS_LIST } from "./list";
import { buildThreadTestContext, type ThreadTestEnv } from "./test-helpers";

describe("COLLECTION_THREADS_LIST", () => {
  let env: ThreadTestEnv;

  beforeAll(async () => {
    env = await buildThreadTestContext();
  });
  afterAll(async () => {
    await env.close();
  });

  it("surfaces trigger_id on list response items", async () => {
    // automation_triggers has a foreign key from threads.trigger_id, so seed
    // a parent automation + trigger row before creating the automation thread.
    const now = new Date().toISOString();
    await env.database.db
      .insertInto("automations")
      .values({
        id: "auto_1",
        organization_id: env.orgId,
        name: "auto",
        active: true,
        created_by: env.userId,
        messages: "[]",
        models: "{}",
        temperature: 0.5,
        virtual_mcp_id: "vmcp_test",
        created_at: now,
        updated_at: now,
      })
      .execute();
    await env.database.db
      .insertInto("automation_triggers")
      .values({
        id: "trig_42",
        automation_id: "auto_1",
        type: "cron",
        cron_expression: "0 * * * *",
        created_at: now,
      })
      .execute();

    await env.ctx.storage.threads.create({
      id: "thrd_with_trigger",
      title: "automation thread",
      created_by: env.userId,
      trigger_id: "trig_42",
    });
    await env.ctx.storage.threads.create({
      id: "thrd_without_trigger",
      title: "human thread",
      created_by: env.userId,
      trigger_id: null,
    });

    const raw = await COLLECTION_THREADS_LIST.handler(
      {
        limit: 10,
        offset: 0,
        orderBy: [{ field: ["updated_at"], direction: "desc" }],
      },
      env.ctx,
    );

    // Round-trip through the output schema to verify clients actually
    // receive trigger_id (the schema strips fields it doesn't declare).
    const parsed = COLLECTION_THREADS_LIST.outputSchema.parse(raw) as {
      items: Array<{ id: string; trigger_id?: string | null }>;
    };
    const withTrigger = parsed.items.find((i) => i.id === "thrd_with_trigger");
    const withoutTrigger = parsed.items.find(
      (i) => i.id === "thrd_without_trigger",
    );
    expect(withTrigger?.trigger_id).toBe("trig_42");
    expect(withoutTrigger?.trigger_id).toBeNull();
  });
});
