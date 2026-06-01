import { describe, expect, it } from "bun:test";
import type { Task } from "@/web/components/chat/task/types";
import {
  buildShowMoreArgs,
  deriveGroupHasMore,
  GROUP_PAGE_SIZE,
  nextPageOffset,
  type SidebarFilters,
} from "./next-page-offset";

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

describe("deriveGroupHasMore", () => {
  it("is true when the group already has a full page loaded", () => {
    expect(deriveGroupHasMore(GROUP_PAGE_SIZE, false)).toBe(true);
  });

  it("is true when the global list may still hide rows for this group", () => {
    expect(deriveGroupHasMore(2, true)).toBe(true);
  });

  it("is false when the group is partial and the global list is exhausted", () => {
    expect(deriveGroupHasMore(3, false)).toBe(false);
  });

  it("is true for an empty group while the global list has more pages", () => {
    expect(deriveGroupHasMore(0, true)).toBe(true);
  });
});

describe("buildShowMoreArgs", () => {
  it("places virtual_mcp_id inside where for agent mode", () => {
    const args = buildShowMoreArgs("agent", "vm-a", 0, noFilters, 10);
    expect(args.where.virtual_mcp_id).toBe("vm-a");
    expect(args.where.hidden).toBe(false);
    expect(args.status).toBeUndefined();
  });

  it("places status at the top level for status mode (not inside where)", () => {
    const args = buildShowMoreArgs("status", "in_progress", 0, noFilters, 10);
    expect(args.status).toBe("in_progress");
    expect(args.where.virtual_mcp_id).toBeUndefined();
    expect((args.where as { status?: unknown }).status).toBeUndefined();
  });

  it("adds created_by to where when member=mine and currentUserId is set", () => {
    const args = buildShowMoreArgs(
      "agent",
      "vm-a",
      0,
      {
        type: "all",
        member: "mine",
        currentUserId: "u-1",
      },
      10,
    );
    expect(args.where.created_by).toBe("u-1");
  });

  it("omits created_by when member=mine but currentUserId is null", () => {
    const args = buildShowMoreArgs(
      "agent",
      "vm-a",
      0,
      {
        type: "all",
        member: "mine",
        currentUserId: null,
      },
      10,
    );
    expect(args.where.created_by).toBeUndefined();
  });

  it("sets has_trigger=true for automation type filter", () => {
    const args = buildShowMoreArgs(
      "agent",
      "vm-a",
      0,
      {
        type: "automation",
        member: "all",
        currentUserId: null,
      },
      10,
    );
    expect(args.where.has_trigger).toBe(true);
  });

  it("sets has_trigger=false for manual type filter", () => {
    const args = buildShowMoreArgs(
      "agent",
      "vm-a",
      0,
      {
        type: "manual",
        member: "all",
        currentUserId: null,
      },
      10,
    );
    expect(args.where.has_trigger).toBe(false);
  });

  it("uses the provided limit and offset", () => {
    const args = buildShowMoreArgs("agent", "vm-a", 25, noFilters, 7);
    expect(args.limit).toBe(7);
    expect(args.offset).toBe(25);
  });

  it("always orders by updated_at desc", () => {
    const args = buildShowMoreArgs("agent", "vm-a", 0, noFilters, 10);
    expect(args.orderBy).toEqual([
      { field: ["updated_at"], direction: "desc" },
    ]);
  });
});
