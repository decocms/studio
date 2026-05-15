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
