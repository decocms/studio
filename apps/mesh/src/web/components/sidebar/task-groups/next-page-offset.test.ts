import { describe, expect, it } from "bun:test";
import type { Task } from "@/web/components/chat/task/types";
import { nextPageOffset, type SidebarFilters } from "./next-page-offset";

const t = (overrides: Partial<Task>): Task => ({
  id: overrides.id ?? "x",
  title: overrides.title ?? "x",
  created_at: overrides.created_at ?? "2026-01-01T00:00:00Z",
  updated_at: overrides.updated_at ?? "2026-01-01T00:00:00Z",
  ...overrides,
});

const noFilters: SidebarFilters = {
  type: "all",
  member: "all",
  currentUserId: null,
};

describe("nextPageOffset", () => {
  it("counts agent matches", () => {
    const threads = [
      t({ id: "1", virtual_mcp_id: "vm-a" }),
      t({ id: "2", virtual_mcp_id: "vm-b" }),
      t({ id: "3", virtual_mcp_id: "vm-a" }),
    ];
    expect(nextPageOffset(threads, "agent", "vm-a", noFilters)).toBe(2);
    expect(nextPageOffset(threads, "agent", "vm-b", noFilters)).toBe(1);
  });

  it("counts status matches", () => {
    const threads = [
      t({ id: "1", status: "in_progress" }),
      t({ id: "2", status: "completed" }),
      t({ id: "3", status: "in_progress" }),
    ];
    expect(nextPageOffset(threads, "status", "in_progress", noFilters)).toBe(2);
  });

  it("excludes hidden threads", () => {
    const threads = [
      t({ id: "1", virtual_mcp_id: "vm-a" }),
      t({ id: "2", virtual_mcp_id: "vm-a", hidden: true }),
    ];
    expect(nextPageOffset(threads, "agent", "vm-a", noFilters)).toBe(1);
  });

  it("applies the mine-only member filter", () => {
    const threads = [
      t({ id: "1", virtual_mcp_id: "vm-a", created_by: "user-1" }),
      t({ id: "2", virtual_mcp_id: "vm-a", created_by: "user-2" }),
    ];
    expect(
      nextPageOffset(threads, "agent", "vm-a", {
        type: "all",
        member: "mine",
        currentUserId: "user-1",
      }),
    ).toBe(1);
  });

  it("applies the automation type filter", () => {
    const threads = [
      t({ id: "1", virtual_mcp_id: "vm-a", trigger_id: "trg" }),
      t({ id: "2", virtual_mcp_id: "vm-a", trigger_id: null }),
    ];
    expect(
      nextPageOffset(threads, "agent", "vm-a", {
        type: "automation",
        member: "all",
        currentUserId: null,
      }),
    ).toBe(1);
  });
});
