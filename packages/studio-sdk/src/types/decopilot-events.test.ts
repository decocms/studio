import { describe, expect, test } from "bun:test";
import {
  createDecopilotThreadStatusEvent,
  DECOPILOT_EVENTS,
} from "./decopilot-events";

describe("createDecopilotThreadStatusEvent", () => {
  test("carries virtualMcpId, createdBy, and triggerId on data", () => {
    const e = createDecopilotThreadStatusEvent("task-1", "in_progress", {
      virtualMcpId: "vm-1",
      createdBy: "user-1",
      triggerId: "trig-1",
    });
    expect(e.type).toBe(DECOPILOT_EVENTS.THREAD_STATUS);
    expect(e.subject).toBe("task-1");
    expect(e.data.status).toBe("in_progress");
    expect(e.data.virtual_mcp_id).toBe("vm-1");
    expect(e.data.created_by).toBe("user-1");
    expect(e.data.trigger_id).toBe("trig-1");
  });

  test("omits optional fields when not provided", () => {
    const e = createDecopilotThreadStatusEvent("task-1", "completed");
    expect(e.data.status).toBe("completed");
    expect(e.data.virtual_mcp_id).toBeUndefined();
    expect(e.data.created_by).toBeUndefined();
    expect(e.data.trigger_id).toBeUndefined();
  });

  test("preserves explicit null trigger_id (human-initiated thread)", () => {
    const e = createDecopilotThreadStatusEvent("task-1", "completed", {
      triggerId: null,
    });
    expect(e.data.trigger_id).toBeNull();
  });

  test("works with only virtualMcpId provided (migration shape)", () => {
    const e = createDecopilotThreadStatusEvent("task-1", "in_progress", {
      virtualMcpId: "vm-1",
    });
    expect(e.data.virtual_mcp_id).toBe("vm-1");
    expect(e.data.created_by).toBeUndefined();
    expect(e.data.trigger_id).toBeUndefined();
  });
});

describe("createDecopilotThreadStatusEvent — enriched fields", () => {
  test("round-trips title, branch, createdAt, updatedAt", () => {
    const e = createDecopilotThreadStatusEvent("task-1", "in_progress", {
      virtualMcpId: "vm-1",
      title: "Refactor login",
      branch: "feature/login",
      createdAt: "2026-05-19T00:00:00.000Z",
      updatedAt: "2026-05-19T00:05:00.000Z",
    });
    expect(e.data.title).toBe("Refactor login");
    expect(e.data.branch).toBe("feature/login");
    expect(e.data.created_at).toBe("2026-05-19T00:00:00.000Z");
    expect(e.data.updated_at).toBe("2026-05-19T00:05:00.000Z");
  });

  test("omits the new fields when not provided", () => {
    const e = createDecopilotThreadStatusEvent("task-1", "in_progress", {
      virtualMcpId: "vm-1",
    });
    expect(e.data.title).toBeUndefined();
    expect(e.data.branch).toBeUndefined();
    expect(e.data.created_at).toBeUndefined();
    expect(e.data.updated_at).toBeUndefined();
  });

  test("explicit null branch is preserved", () => {
    const e = createDecopilotThreadStatusEvent("task-1", "in_progress", {
      branch: null,
    });
    expect(e.data.branch).toBeNull();
  });
});
