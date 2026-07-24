import { describe, expect, it } from "bun:test";
import type { Task } from "@/components/chat/task/types";
import { findArchiveFallback } from "./archive-fallback";

const task = (id: string, createdBy: string, agentId: string): Task => ({
  id,
  title: id,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  created_by: createdBy,
  virtual_mcp_id: agentId,
});

describe("findArchiveFallback", () => {
  it("selects the next owned row even when it belongs to another agent", () => {
    const threads = [
      task("current", "me", "agent-a"),
      task("next", "me", "agent-b"),
    ];

    expect(findArchiveFallback(threads, "current", "me")?.id).toBe("next");
  });

  it("skips teammate rows while scanning downward", () => {
    const threads = [
      task("current", "me", "agent-a"),
      task("teammate", "them", "agent-b"),
      task("mine", "me", "agent-c"),
    ];

    expect(findArchiveFallback(threads, "current", "me")?.id).toBe("mine");
  });

  it("falls back to the closest owned row above", () => {
    const threads = [
      task("mine", "me", "agent-a"),
      task("teammate", "them", "agent-b"),
      task("current", "me", "agent-c"),
    ];

    expect(findArchiveFallback(threads, "current", "me")?.id).toBe("mine");
  });

  it("returns no fallback when only teammate rows remain", () => {
    const threads = [
      task("current", "me", "agent-a"),
      task("teammate", "them", "agent-b"),
    ];

    expect(findArchiveFallback(threads, "current", "me")).toBeUndefined();
  });
});
