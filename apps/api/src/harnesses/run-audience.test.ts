import { describe, expect, test } from "bun:test";
import { TASK_RUN_INSTRUCTIONS_KEY } from "@/harnesses/claude-code-env";
import { AUTOMATION_THREAD_KEY } from "@/storage/automations";
import { runAudience, threadAudience } from "./run-audience";

const chat = { title: "Fix the header", created_by: "user_1", metadata: {} };
const base = { runClass: undefined, userId: "user_1", thread: chat };

describe("runAudience", () => {
  test("the member who opened the chat is its owner", () => {
    expect(runAudience(base)).toBe("owner");
  });

  test("a legacy chat row without metadata or trigger is still its opener's", () => {
    const thread = {
      title: null,
      created_by: "user_1",
      metadata: null,
      trigger_id: null,
    };
    expect(runAudience({ ...base, thread })).toBe("owner");
  });

  test("a teammate in a chat someone else opened is attended, not owner", () => {
    expect(runAudience({ ...base, userId: "user_2" })).toBe("attended");
    const ownerless = { title: "Fix the header", metadata: {} };
    expect(runAudience({ ...base, thread: ownerless })).toBe("attended");
  });

  test("a thread a trigger created is unattended", () => {
    const thread = { ...chat, trigger_id: "trig_1" };
    expect(runAudience({ ...base, thread })).toBe("unattended");
  });

  test("an automation's thread is unattended, manual run included", () => {
    const thread = {
      ...chat,
      trigger_id: null,
      metadata: { [AUTOMATION_THREAD_KEY]: "auto_1" },
    };
    expect(runAudience({ ...base, thread })).toBe("unattended");
  });

  test("a board run's thread is unattended, whoever types into it", () => {
    const thread = {
      ...chat,
      title: "Super Agent: Fix the header",
      metadata: { [TASK_RUN_INSTRUCTIONS_KEY]: "Work the card." },
    };
    for (const userId of ["user_1", "user_2"]) {
      expect(runAudience({ ...base, userId, thread })).toBe("unattended");
    }
  });

  test("a thread with a board tool surface is unattended: reviewer and Jira", () => {
    const reviewer = { ...chat, title: "Reviewer: Fix the header" };
    const jira = { ...chat, metadata: { source: "jira" } };
    expect(runAudience({ ...base, thread: reviewer })).toBe("unattended");
    expect(runAudience({ ...base, thread: jira })).toBe("unattended");
  });

  test("a classed run is unattended even on a chat its owner opened", () => {
    for (const runClass of ["new_task", "reviewer", "retry", "triggered"]) {
      expect(runAudience({ ...base, runClass })).toBe("unattended");
    }
  });

  test("a thread stamped with any source is unattended", () => {
    const thread = { ...chat, metadata: { source: "other" } };
    expect(runAudience({ ...base, thread })).toBe("unattended");
  });

  test("a missing thread is unattended", () => {
    expect(runAudience({ ...base, thread: null })).toBe("unattended");
    expect(runAudience({ ...base, thread: undefined })).toBe("unattended");
  });
});

describe("threadAudience", () => {
  test("reads the thread alone: owner, teammate, nobody", () => {
    expect(threadAudience(chat, "user_1")).toBe("owner");
    expect(threadAudience(chat, "user_2")).toBe("attended");
    expect(threadAudience({ ...chat, trigger_id: "trig_1" }, "user_1")).toBe(
      "unattended",
    );
    expect(threadAudience(null, "user_1")).toBe("unattended");
  });

  test("a source other than Jira does not make a thread unattended by itself", () => {
    const thread = { ...chat, metadata: { source: "other" } };
    expect(threadAudience(thread, "user_1")).toBe("owner");
  });
});
