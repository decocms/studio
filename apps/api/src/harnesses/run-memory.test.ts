import { describe, expect, test } from "bun:test";
import { TASK_RUN_INSTRUCTIONS_KEY } from "@/harnesses/claude-code-env";
import { AUTOMATION_THREAD_KEY } from "@/storage/automations";
import { resolveRunMemory } from "./run-memory";

const chat = { title: "Fix the header", created_by: "user_1", metadata: {} };
const base = { enabled: true, orgFsMounted: true, userId: "user_1" };
const OFF = { enabled: false as const };

describe("resolveRunMemory", () => {
  test("a chat the member opened gets that member's folder", () => {
    expect(resolveRunMemory({ ...base, thread: chat })).toEqual({
      enabled: true,
      directory: "users/user_1",
    });
  });

  test("a legacy chat row without metadata or trigger still counts as a chat", () => {
    expect(
      resolveRunMemory({
        ...base,
        thread: {
          title: null,
          created_by: "user_1",
          metadata: null,
          trigger_id: null,
        },
      }),
    ).toEqual({ enabled: true, directory: "users/user_1" });
  });

  test("two members never resolve to the same folder", () => {
    const one = resolveRunMemory({ ...base, thread: chat });
    const other = resolveRunMemory({
      ...base,
      userId: "user_2",
      thread: { ...chat, created_by: "user_2" },
    });
    expect(other).toEqual({ enabled: true, directory: "users/user_2" });
    expect(other).not.toEqual(one);
  });

  test("the flag off leaves the harness default", () => {
    expect(
      resolveRunMemory({ ...base, enabled: false, thread: chat }),
    ).toBeUndefined();
    const boardRun = {
      ...chat,
      metadata: { [TASK_RUN_INSTRUCTIONS_KEY]: "Work the card." },
    };
    expect(
      resolveRunMemory({ ...base, enabled: false, thread: boardRun }),
    ).toBeUndefined();
  });

  test("a board run gets none, whoever types into its thread", () => {
    const thread = {
      ...chat,
      title: "Super Agent: Fix the header",
      metadata: { [TASK_RUN_INSTRUCTIONS_KEY]: "Work the card." },
    };
    expect(resolveRunMemory({ ...base, thread })).toEqual(OFF);
  });

  test("a reviewer run gets none", () => {
    const thread = { ...chat, title: "Reviewer: Fix the header" };
    expect(resolveRunMemory({ ...base, thread })).toEqual(OFF);
  });

  test("a Jira run gets none", () => {
    const thread = { ...chat, metadata: { source: "jira" } };
    expect(resolveRunMemory({ ...base, thread })).toEqual(OFF);
  });

  test("a thread a trigger created gets none", () => {
    const thread = { ...chat, trigger_id: "trig_1" };
    expect(resolveRunMemory({ ...base, thread })).toEqual(OFF);
  });

  test("an automation's manual run, which has no trigger, gets none", () => {
    const thread = {
      ...chat,
      trigger_id: null,
      metadata: { [AUTOMATION_THREAD_KEY]: "auto_1" },
    };
    expect(resolveRunMemory({ ...base, thread })).toEqual(OFF);
  });

  test("a run acting as someone other than the chat's opener gets none", () => {
    expect(
      resolveRunMemory({ ...base, userId: "user_2", thread: chat }),
    ).toEqual(OFF);
    const ownerless = { title: "Fix the header", metadata: {} };
    expect(resolveRunMemory({ ...base, thread: ownerless })).toEqual(OFF);
  });

  test("a missing thread gets none", () => {
    expect(resolveRunMemory({ ...base, thread: null })).toEqual(OFF);
    expect(resolveRunMemory({ ...base, thread: undefined })).toEqual(OFF);
  });

  test("no org filesystem means no memory, never a sandbox-local folder", () => {
    expect(
      resolveRunMemory({ ...base, orgFsMounted: false, thread: chat }),
    ).toEqual(OFF);
  });

  test("a user id that is not one folder name gets none", () => {
    for (const userId of ["", ".", "..", "a/b", "../user_2", "a\\b", "a\0b"]) {
      const thread = { ...chat, created_by: userId };
      expect(resolveRunMemory({ ...base, userId, thread })).toEqual(OFF);
    }
  });
});
