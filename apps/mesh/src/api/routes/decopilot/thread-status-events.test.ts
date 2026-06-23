import { describe, expect, test } from "bun:test";
import type { SSEEvent } from "@/event-bus";
import { emitTerminalThreadStatus } from "./thread-status-events";

function fakeHub() {
  const events: Array<{ orgId: string; event: SSEEvent }> = [];
  return {
    events,
    emit: (orgId: string, event: SSEEvent) => {
      events.push({ orgId, event });
    },
  };
}

describe("emitTerminalThreadStatus", () => {
  test("emits a decopilot.thread.status event for a completed flip", () => {
    const hub = fakeHub();
    const emitted = emitTerminalThreadStatus(hub, "org-1", "thread-1", {
      status: "completed",
      title: "My thread",
      virtual_mcp_id: "vir_x",
      created_by: "user-1",
      trigger_id: null,
      branch: "main",
      created_at: "2026-06-23T00:00:00.000Z",
      updated_at: "2026-06-23T00:01:00.000Z",
    });
    expect(emitted).toBe(true);
    expect(hub.events).toHaveLength(1);
    expect(hub.events[0]!.orgId).toBe("org-1");
    const ev = hub.events[0]!.event as {
      subject: string;
      data: { status: string };
    };
    expect(ev.subject).toBe("thread-1");
    expect(ev.data.status).toBe("completed");
  });

  test("carries the failed status through", () => {
    const hub = fakeHub();
    emitTerminalThreadStatus(hub, "org-1", "thread-1", { status: "failed" });
    const ev = hub.events[0]!.event as { data: { status: string } };
    expect(ev.data.status).toBe("failed");
  });

  test("no-op (emits nothing) when the flip was a no-op (null row)", () => {
    // A null row means the run was already terminal (e.g. a hosted run that the
    // live path already finalized). Emitting would double-publish the status.
    const hub = fakeHub();
    const emitted = emitTerminalThreadStatus(hub, "org-1", "thread-1", null);
    expect(emitted).toBe(false);
    expect(hub.events).toHaveLength(0);
  });
});
