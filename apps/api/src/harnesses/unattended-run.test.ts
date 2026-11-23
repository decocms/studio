import { describe, expect, test } from "bun:test";
import { TASK_RUN_INSTRUCTIONS_KEY } from "@/harnesses/claude-code-env";
import { AUTOMATION_THREAD_KEY } from "@/storage/automations";
import { isUnattendedRun, isUnattendedThread } from "./unattended-run";

const chat = { title: "Fix the header", created_by: "user_1", metadata: {} };
const base = { runClass: undefined, thread: chat };

describe("isUnattendedRun", () => {
  test("a chat a member opened has that member in it", () => {
    expect(isUnattendedRun(base)).toBe(false);
  });

  test("a legacy chat row without metadata or trigger is still a chat", () => {
    const thread = {
      title: null,
      created_by: "user_1",
      metadata: null,
      trigger_id: null,
    };
    expect(isUnattendedRun({ ...base, thread })).toBe(false);
  });

  test("a thread a trigger created is unattended", () => {
    const thread = { ...chat, trigger_id: "trig_1" };
    expect(isUnattendedRun({ ...base, thread })).toBe(true);
  });

  test("an automation's thread is unattended, manual run included", () => {
    const thread = {
      ...chat,
      trigger_id: null,
      metadata: { [AUTOMATION_THREAD_KEY]: "auto_1" },
    };
    expect(isUnattendedRun({ ...base, thread })).toBe(true);
  });

  test("a board run's thread is unattended", () => {
    const thread = {
      ...chat,
      title: "Super Agent: Fix the header",
      metadata: { [TASK_RUN_INSTRUCTIONS_KEY]: "Work the card." },
    };
    expect(isUnattendedRun({ ...base, thread })).toBe(true);
  });

  test("a thread with a board tool surface is unattended: reviewer and Jira", () => {
    const reviewer = { ...chat, title: "Reviewer: Fix the header" };
    const jira = { ...chat, metadata: { source: "jira" } };
    expect(isUnattendedRun({ ...base, thread: reviewer })).toBe(true);
    expect(isUnattendedRun({ ...base, thread: jira })).toBe(true);
  });

  test("a classed run is unattended even on a chat a member opened", () => {
    for (const runClass of ["new_task", "reviewer", "retry", "triggered"]) {
      expect(isUnattendedRun({ ...base, runClass })).toBe(true);
    }
  });

  test("a thread stamped with any source is unattended", () => {
    const thread = { ...chat, metadata: { source: "other" } };
    expect(isUnattendedRun({ ...base, thread })).toBe(true);
  });

  test("a missing thread is unattended", () => {
    expect(isUnattendedRun({ ...base, thread: null })).toBe(true);
    expect(isUnattendedRun({ ...base, thread: undefined })).toBe(true);
  });
});

describe("isUnattendedThread", () => {
  test("reads the thread alone", () => {
    expect(isUnattendedThread(chat)).toBe(false);
    expect(isUnattendedThread({ ...chat, trigger_id: "trig_1" })).toBe(true);
  });

  test("a source other than Jira does not make a thread unattended by itself", () => {
    expect(isUnattendedThread({ ...chat, metadata: { source: "other" } })).toBe(
      false,
    );
  });
});
