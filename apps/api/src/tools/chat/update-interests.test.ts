import { describe, expect, it } from "bun:test";
import { taskRunContextStore } from "../task-board/task-run-context";
import { chatToolContext } from "./test-helpers";
import { UPDATE_INTERESTS } from "./update-interests";

const interests = [{ title: "Learning Rust", summary: "Halfway through." }];

describe("update_interests", () => {
  it("writes the user's interests for the thread's agent", async () => {
    const writes: unknown[][] = [];
    const ctx = chatToolContext();
    const storage = {
      ...ctx.storage,
      interests: {
        setForAgent: async (...args: unknown[]) => void writes.push(args),
      },
    };
    const result = await taskRunContextStore.run({ threadId: "thrd_1" }, () =>
      UPDATE_INTERESTS.handler({ interests }, { ...ctx, storage } as never),
    );
    expect(result).toEqual({ ok: true, count: 1 });
    expect(writes).toEqual([["org_1", "vmcp_1", "user_1", { interests }]]);
  });

  it("refuses outside a thread's endpoint — there is no agent to scope to", async () => {
    await expect(
      UPDATE_INTERESTS.handler({ interests }, chatToolContext()),
    ).rejects.toThrow(/thread's MCP endpoint/);
  });

  it("refuses a thread the org cannot see", async () => {
    await expect(
      taskRunContextStore.run({ threadId: "thrd_other_org" }, () =>
        UPDATE_INTERESTS.handler({ interests }, chatToolContext()),
      ),
    ).rejects.toThrow(/Thread not found/);
  });
});
