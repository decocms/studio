import { describe, expect, it } from "bun:test";
import type { Task } from "@/components/chat/task/types";
import { hideAbandonedNewChats } from "./thread-list-visibility";

const task = (over: Partial<Task>): Task =>
  ({
    id: over.id ?? crypto.randomUUID(),
    title: over.title ?? "New chat",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    virtual_mcp_id: "agent-1",
    created_by: "user-1",
    ...over,
  }) as Task;

describe("hideAbandonedNewChats", () => {
  it("drops an empty New chat that is not the active thread", () => {
    const t = task({ id: "a" });
    expect(hideAbandonedNewChats([t], "other")).toEqual([]);
  });

  it("keeps the active empty New chat so it never vanishes under the user", () => {
    const t = task({ id: "a" });
    expect(hideAbandonedNewChats([t], "a")).toEqual([t]);
  });

  it("keeps a chat with a message (harness_id pinned)", () => {
    const t = task({ id: "a", harness_id: "h1" });
    expect(hideAbandonedNewChats([t], "other")).toEqual([t]);
  });

  it("keeps a chat that was auto-titled after a successful turn", () => {
    const t = task({ id: "a", title: "Fix the login bug" });
    expect(hideAbandonedNewChats([t], "other")).toEqual([t]);
  });

  it("keeps an un-started automation row even when empty", () => {
    const t = task({ id: "a", trigger_id: "trig-1" });
    expect(hideAbandonedNewChats([t], "other")).toEqual([t]);
  });
});
