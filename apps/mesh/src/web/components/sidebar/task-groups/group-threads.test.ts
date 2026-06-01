import { describe, expect, it } from "bun:test";
import type { Task } from "@/web/components/chat/task/types";
import {
  groupThreadsByVirtualMcp,
  groupThreadsByStatus,
} from "./group-threads";

const t = (overrides: Partial<Task>): Task => ({
  id: overrides.id ?? "x",
  title: overrides.title ?? "x",
  created_at: overrides.created_at ?? "2026-01-01T00:00:00Z",
  updated_at: overrides.updated_at ?? "2026-01-01T00:00:00Z",
  ...overrides,
});

describe("groupThreadsByVirtualMcp", () => {
  it("pins the decopilot id first regardless of recency", () => {
    const result = groupThreadsByVirtualMcp(
      [
        t({
          id: "a",
          virtual_mcp_id: "vm-other",
          updated_at: "2026-05-01T00:00:00Z",
        }),
        t({
          id: "b",
          virtual_mcp_id: "vm-decopilot",
          updated_at: "2026-04-01T00:00:00Z",
        }),
      ],
      "vm-decopilot",
    );
    expect(result.map((g) => g.virtualMcpId)).toEqual([
      "vm-decopilot",
      "vm-other",
    ]);
  });

  it("orders non-decopilot groups by max updated_at desc", () => {
    const result = groupThreadsByVirtualMcp(
      [
        t({
          id: "a",
          virtual_mcp_id: "vm-1",
          updated_at: "2026-01-01T00:00:00Z",
        }),
        t({
          id: "b",
          virtual_mcp_id: "vm-2",
          updated_at: "2026-03-01T00:00:00Z",
        }),
        t({
          id: "c",
          virtual_mcp_id: "vm-1",
          updated_at: "2026-02-01T00:00:00Z",
        }),
      ],
      null,
    );
    expect(result.map((g) => g.virtualMcpId)).toEqual(["vm-2", "vm-1"]);
  });

  it("preserves input order inside a group (matches updated_at desc of caller)", () => {
    const result = groupThreadsByVirtualMcp(
      [
        t({
          id: "a",
          virtual_mcp_id: "vm-1",
          updated_at: "2026-03-01T00:00:00Z",
        }),
        t({
          id: "b",
          virtual_mcp_id: "vm-1",
          updated_at: "2026-02-01T00:00:00Z",
        }),
        t({
          id: "c",
          virtual_mcp_id: "vm-1",
          updated_at: "2026-01-01T00:00:00Z",
        }),
      ],
      null,
    );
    expect(result[0]?.threads.map((th) => th.id)).toEqual(["a", "b", "c"]);
  });

  it("does not insert decopilot when it has no threads", () => {
    const result = groupThreadsByVirtualMcp(
      [
        t({
          id: "a",
          virtual_mcp_id: "vm-other",
          updated_at: "2026-05-01T00:00:00Z",
        }),
      ],
      "vm-decopilot",
    );
    expect(result.map((g) => g.virtualMcpId)).toEqual(["vm-other"]);
  });

  it("buckets threads without virtual_mcp_id under a synthetic 'tool-call-runs' group at the end", () => {
    const result = groupThreadsByVirtualMcp(
      [
        t({
          id: "a",
          virtual_mcp_id: "vm-1",
          updated_at: "2026-05-01T00:00:00Z",
        }),
        t({
          id: "b",
          virtual_mcp_id: undefined,
          updated_at: "2026-04-01T00:00:00Z",
        }),
      ],
      "vm-decopilot",
    );
    const ids = result.map((g) => g.virtualMcpId);
    expect(ids[ids.length - 1]).toBe("__tool_call_runs__");
  });

  it("returns an empty array when no threads and no decopilot id is supplied", () => {
    const result = groupThreadsByVirtualMcp([], null);
    expect(result).toEqual([]);
  });

  it("returns an empty array when no threads even with decopilot id", () => {
    const result = groupThreadsByVirtualMcp([], "vm-decopilot");
    expect(result).toEqual([]);
  });
});

describe("groupThreadsByVirtualMcp - dangling welcome threads", () => {
  it("filters out threads whose id starts with thrd_welcome_", () => {
    const result = groupThreadsByVirtualMcp(
      [
        t({
          id: "thrd_welcome_studio-brand-manager_org-1",
          virtual_mcp_id: "studio-brand-manager_org-1",
        }),
        t({
          id: "real-thread",
          virtual_mcp_id: "studio-brand-manager_org-1",
        }),
      ],
      null,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.threads.map((th) => th.id)).toEqual(["real-thread"]);
  });

  it("hides the group entirely when only welcome threads remain", () => {
    const result = groupThreadsByVirtualMcp(
      [
        t({
          id: "thrd_welcome_studio-store-manager_org-1",
          virtual_mcp_id: "studio-store-manager_org-1",
        }),
      ],
      null,
    );
    expect(result).toHaveLength(0);
  });
});

describe("groupThreadsByVirtualMcp — no directory seeding", () => {
  it("does not include agents that only exist in the org directory", () => {
    const result = groupThreadsByVirtualMcp(
      [
        t({
          id: "a",
          virtual_mcp_id: "vm-active",
          updated_at: "2026-05-01T00:00:00Z",
        }),
      ],
      null,
    );
    expect(result.map((g) => g.virtualMcpId)).toEqual(["vm-active"]);
  });
});

describe("groupThreadsByStatus", () => {
  it("always returns all 5 status groups regardless of input", () => {
    const result = groupThreadsByStatus([]);
    expect(result).toHaveLength(5);
    expect(result.map((g) => g.status)).toEqual([
      "requires_action",
      "in_progress",
      "failed",
      "expired",
      "completed",
    ]);
  });

  it("returns empty thread arrays for statuses with no matching threads", () => {
    const result = groupThreadsByStatus([]);
    for (const group of result) {
      expect(group.threads).toEqual([]);
    }
  });

  it("buckets threads into the correct status group", () => {
    const result = groupThreadsByStatus([
      t({ id: "a", status: "in_progress" }),
      t({ id: "b", status: "completed" }),
      t({ id: "c", status: "in_progress" }),
    ]);
    expect(result).toHaveLength(5);
    expect(
      result
        .find((g) => g.status === "in_progress")
        ?.threads.map((th) => th.id),
    ).toEqual(["a", "c"]);
    expect(
      result.find((g) => g.status === "completed")?.threads.map((th) => th.id),
    ).toEqual(["b"]);
    expect(result.find((g) => g.status === "requires_action")?.threads).toEqual(
      [],
    );
    expect(result.find((g) => g.status === "failed")?.threads).toEqual([]);
    expect(result.find((g) => g.status === "expired")?.threads).toEqual([]);
  });

  it("preserves the canonical status order: requires_action, in_progress, failed, expired, completed", () => {
    const result = groupThreadsByStatus([
      t({ id: "a", status: "completed" }),
      t({ id: "b", status: "requires_action" }),
    ]);
    expect(result.map((g) => g.status)).toEqual([
      "requires_action",
      "in_progress",
      "failed",
      "expired",
      "completed",
    ]);
  });

  it("falls back threads with unknown status into 'completed'", () => {
    const result = groupThreadsByStatus([t({ id: "a", status: undefined })]);
    expect(
      result.find((g) => g.status === "completed")?.threads.map((th) => th.id),
    ).toEqual(["a"]);
  });
});
