import { describe, expect, test } from "bun:test";
import type { Task } from "@/components/chat/task/types";
import { threadHasMessages } from "./thread-has-messages";

function makeThread(overrides: Partial<Task>): Task {
  return {
    id: "t1",
    title: "New chat",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("threadHasMessages", () => {
  test("an empty New chat with no harness has no messages", () => {
    expect(threadHasMessages(makeThread({ title: "New chat" }))).toBe(false);
  });

  test("a thread with a pinned harness_id has messages", () => {
    // harness_id is pinned on the first message, even one that failed or is in flight.
    expect(
      threadHasMessages(
        makeThread({ title: "New chat", harness_id: "claude-code" }),
      ),
    ).toBe(true);
  });

  test("a titled thread (completed a turn) has messages even without harness_id", () => {
    expect(threadHasMessages(makeThread({ title: "Fix the bug" }))).toBe(true);
  });

  test("an untitled empty thread has no messages", () => {
    expect(threadHasMessages(makeThread({ title: "" }))).toBe(false);
  });
});
