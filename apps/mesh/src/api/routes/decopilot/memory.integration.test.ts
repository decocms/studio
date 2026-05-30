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
      thread_id: thread.id,
      organization_id: env.orgId,
      userId: env.userId,
    });

    expect(memory.thread.id).toBe("thrd_existing");
  });

  it("throws when thread_id is provided but thread does not exist", async () => {
    await expect(
      createMemory(env.ctx.storage.threads, {
        thread_id: "thrd_does_not_exist",
        organization_id: env.orgId,
        userId: env.userId,
      }),
    ).rejects.toThrow(/thread.*not.*found/i);
  });
});
