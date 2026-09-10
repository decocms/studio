import { describe, expect, test } from "bun:test";
import { findLastThreadForAgent } from "./find-last-thread-for-agent";
import type { Task } from "@/components/chat/task/types";

const USER_ID = "user-1";
const AGENT_ID = "agent-1";

function task(overrides: Partial<Task>): Task {
  return {
    id: "t-default",
    title: "Test thread",
    created_at: "2026-04-29T00:00:00.000Z",
    updated_at: "2026-04-29T00:00:00.000Z",
    created_by: USER_ID,
    virtual_mcp_id: AGENT_ID,
    ...overrides,
  };
}

describe("findLastThreadForAgent", () => {
  test("returns null when the list is empty", () => {
    expect(findLastThreadForAgent([], AGENT_ID, USER_ID)).toBeNull();
  });

  test("returns the single matching thread", () => {
    const result = findLastThreadForAgent(
      [task({ id: "t1", updated_at: "2026-04-29T01:00:00.000Z" })],
      AGENT_ID,
      USER_ID,
    );
    expect(result?.id).toBe("t1");
  });

  test("picks the freshest match regardless of list order", () => {
    const result = findLastThreadForAgent(
      [
        task({ id: "older", updated_at: "2026-04-29T01:00:00.000Z" }),
        task({ id: "newer", updated_at: "2026-04-29T05:00:00.000Z" }),
        task({ id: "oldest", updated_at: "2026-04-28T00:00:00.000Z" }),
      ],
      AGENT_ID,
      USER_ID,
    );
    expect(result?.id).toBe("newer");
  });

  test("rejects threads for a different agent", () => {
    expect(
      findLastThreadForAgent(
        [task({ id: "wrong-agent", virtual_mcp_id: "agent-2" })],
        AGENT_ID,
        USER_ID,
      ),
    ).toBeNull();
  });

  test("rejects threads created by a different user", () => {
    expect(
      findLastThreadForAgent(
        [task({ id: "wrong-user", created_by: "user-2" })],
        AGENT_ID,
        USER_ID,
      ),
    ).toBeNull();
  });

  test("returns null when userId is undefined", () => {
    expect(
      findLastThreadForAgent([task({ id: "t1" })], AGENT_ID, undefined),
    ).toBeNull();
  });

  test("rejects archived (hidden) threads even when they are the freshest", () => {
    const result = findLastThreadForAgent(
      [
        task({
          id: "archived",
          hidden: true,
          updated_at: "2026-04-29T05:00:00.000Z",
        }),
        task({ id: "live", updated_at: "2026-04-29T01:00:00.000Z" }),
      ],
      AGENT_ID,
      USER_ID,
    );
    expect(result?.id).toBe("live");
  });

  test("resumes a real conversation, not gated on the New chat marker", () => {
    // Unlike findReusableNewChat, a titled thread with a harness_id still wins.
    const result = findLastThreadForAgent(
      [task({ id: "real", title: "Fix the build", harness_id: "h1" })],
      AGENT_ID,
      USER_ID,
    );
    expect(result?.id).toBe("real");
  });
});
