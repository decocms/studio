import { describe, expect, test } from "bun:test";
import { applyPatch } from "./thread-events";
import type { TasksQueryData } from "./types";

const emptyData: TasksQueryData = { items: [], hasMore: false };

describe("applyPatch", () => {
  test("synthetic row carries created_by and trigger_id when provided", () => {
    const out = applyPatch(emptyData, {
      id: "t1",
      created_by: "user-1",
      trigger_id: "trig-1",
      status: "in_progress",
      updated_at: "2026-05-15T00:00:00Z",
    });
    expect(out?.items[0]).toMatchObject({
      id: "t1",
      created_by: "user-1",
      trigger_id: "trig-1",
      status: "in_progress",
    });
  });

  test("synthetic row preserves null trigger_id (human-initiated)", () => {
    const out = applyPatch(emptyData, {
      id: "t1",
      created_by: "user-1",
      trigger_id: null,
    });
    expect(out?.items[0]?.trigger_id).toBeNull();
  });

  test("patching an existing row does not clobber created_by / trigger_id when undefined", () => {
    const existing: TasksQueryData = {
      items: [
        {
          id: "t1",
          title: "Existing",
          created_at: "2026-05-15T00:00:00Z",
          updated_at: "2026-05-15T00:00:00Z",
          created_by: "user-1",
          trigger_id: "trig-1",
        },
      ],
      hasMore: false,
    };
    const out = applyPatch(existing, { id: "t1", status: "completed" });
    expect(out?.items[0]).toMatchObject({
      created_by: "user-1",
      trigger_id: "trig-1",
      status: "completed",
    });
  });

  test("patching can update trigger_id when explicitly carried", () => {
    const existing: TasksQueryData = {
      items: [
        {
          id: "t1",
          title: "Existing",
          created_at: "2026-05-15T00:00:00Z",
          updated_at: "2026-05-15T00:00:00Z",
          trigger_id: null,
        },
      ],
      hasMore: false,
    };
    const out = applyPatch(existing, { id: "t1", trigger_id: "trig-1" });
    expect(out?.items[0]?.trigger_id).toBe("trig-1");
  });

  test("synthetic row carries virtual_mcp_id when provided (so the agent icon renders on SSE-inserted rows)", () => {
    const out = applyPatch(emptyData, {
      id: "t1",
      virtual_mcp_id: "vmcp-1",
      status: "in_progress",
      updated_at: "2026-05-15T00:00:00Z",
    });
    expect(out?.items[0]?.virtual_mcp_id).toBe("vmcp-1");
  });

  test("patching an existing row does not clobber virtual_mcp_id when undefined", () => {
    const existing: TasksQueryData = {
      items: [
        {
          id: "t1",
          title: "Existing",
          created_at: "2026-05-15T00:00:00Z",
          updated_at: "2026-05-15T00:00:00Z",
          virtual_mcp_id: "vmcp-1",
        },
      ],
      hasMore: false,
    };
    const out = applyPatch(existing, { id: "t1", status: "completed" });
    expect(out?.items[0]?.virtual_mcp_id).toBe("vmcp-1");
  });
});
