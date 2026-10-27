import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { BackgroundTasks } from "./background-tasks";

const system = (fields: Record<string, unknown>) =>
  ({ type: "system", uuid: "u", session_id: "s", ...fields }) as SDKMessage;

describe("BackgroundTasks", () => {
  test("a backgrounded task runs until its notification", () => {
    const tasks = new BackgroundTasks();
    tasks.observe(
      system({ subtype: "task_started", task_id: "t1", is_backgrounded: true }),
    );
    expect(tasks.size).toBe(1);
    tasks.observe(
      system({
        subtype: "task_notification",
        task_id: "t1",
        status: "completed",
      }),
    );
    expect(tasks.size).toBe(0);
  });

  test("foreground and ambient tasks are not waited on", () => {
    const tasks = new BackgroundTasks();
    tasks.observe(
      system({
        subtype: "task_started",
        task_id: "fg",
        is_backgrounded: false,
      }),
    );
    tasks.observe(
      system({
        subtype: "task_started",
        task_id: "watcher",
        is_backgrounded: true,
        ambient: true,
      }),
    );
    expect(tasks.size).toBe(0);
  });

  test("a task moved to the background counts until it settles", () => {
    const tasks = new BackgroundTasks();
    tasks.observe(
      system({
        subtype: "task_started",
        task_id: "t2",
        is_backgrounded: false,
      }),
    );
    tasks.observe(
      system({
        subtype: "task_updated",
        task_id: "t2",
        patch: { is_backgrounded: true },
      }),
    );
    expect(tasks.size).toBe(1);
    tasks.observe(
      system({
        subtype: "task_updated",
        task_id: "t2",
        patch: { status: "paused" },
      }),
    );
    expect(tasks.size).toBe(1);
    tasks.observe(
      system({
        subtype: "task_updated",
        task_id: "t2",
        patch: { status: "killed" },
      }),
    );
    expect(tasks.size).toBe(0);
  });
});
