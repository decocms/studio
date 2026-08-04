import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createMemory } from "./memory";
import {
  buildThreadTestContext,
  type ThreadTestEnv,
} from "../../../tools/thread/test-helpers";

describe("createMemory", () => {
  let env: ThreadTestEnv;

  beforeAll(async () => {
    env = await buildThreadTestContext();
  });
  afterAll(async () => {
    await env.close();
  });

  it("returns Memory when thread exists", async () => {
    const thread = await env.ctx.storage.threads.create({
      id: "thrd_existing",
      organization_id: env.orgId,
      title: "ok",
      created_by: env.userId,
      virtual_mcp_id: "vmcp_x",
    });

    const memory = await createMemory(env.ctx.storage.threads, {
      threadId: thread.id,
    });

    expect(memory.thread.id).toBe("thrd_existing");
  });

  it("throws when threadId is provided but thread does not exist", async () => {
    await expect(
      createMemory(env.ctx.storage.threads, {
        threadId: "thrd_does_not_exist",
      }),
    ).rejects.toThrow(/thread.*not.*found/i);
  });
});
