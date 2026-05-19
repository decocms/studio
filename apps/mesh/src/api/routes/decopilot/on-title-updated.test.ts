/**
 * Unit tests for the onTitleUpdated callback wiring.
 *
 * Tests exercise the exported `buildOnTitleUpdated` function from
 * on-title-updated.ts — the same code path used by dispatch-run's
 * prepareRun() — so drift between tests and production behaviour is
 * impossible.
 */

import { describe, it, expect, mock } from "bun:test";
import { createDecopilotThreadStatusEvent } from "@decocms/mesh-sdk";
import type { Thread } from "@/storage/types";
import { buildOnTitleUpdated } from "./on-title-updated";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    organization_id: "org-1",
    title: "New chat",
    description: null,
    status: "in_progress",
    hidden: null,
    virtual_mcp_id: "vmcp-1",
    created_by: "user-1",
    updated_by: undefined,
    trigger_id: null,
    context_start_message_id: null,
    branch: null,
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-02T00:00:00.000Z",
    run_owner_pod: null,
    run_config: null,
    run_started_at: null,
    inflight_async_jobs: null,
    metadata: {},
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("onTitleUpdated callback", () => {
  it("emits a thread.status SSE event with the new title and full row data", async () => {
    const thread = makeThread({ title: "New chat" });
    const getThread = mock(() => Promise.resolve(thread));
    const sseHub = { emit: mock(() => {}) };

    const ctx = {
      storage: {
        threads: {
          get: getThread,
        },
      },
    } as unknown as import("@/core/mesh-context").MeshContext;

    const onTitleUpdated = buildOnTitleUpdated({
      ctx,
      sseHub,
      threadId: "thread-1",
      organizationId: "org-1",
    });

    await onTitleUpdated("My generated title");

    expect(getThread).toHaveBeenCalledWith("thread-1");
    expect(sseHub.emit).toHaveBeenCalledTimes(1);

    const [emittedOrgId, emittedEvent] = (
      sseHub.emit as ReturnType<typeof mock>
    ).mock.calls[0] as [
      string,
      ReturnType<typeof createDecopilotThreadStatusEvent>,
    ];

    expect(emittedOrgId).toBe("org-1");
    expect(emittedEvent.type).toBe("decopilot.thread.status");
    expect(emittedEvent.subject).toBe("thread-1");
    expect(emittedEvent.data.status).toBe("in_progress");
    expect(emittedEvent.data.title).toBe("My generated title");
    expect(emittedEvent.data.virtual_mcp_id).toBe("vmcp-1");
    expect(emittedEvent.data.created_by).toBe("user-1");
    expect(emittedEvent.data.created_at).toBe("2024-01-01T00:00:00.000Z");
    expect(emittedEvent.data.updated_at).toBe("2024-01-02T00:00:00.000Z");
  });

  it("still emits (with title only) when storage.get throws — best-effort", async () => {
    const getThread = mock(() => Promise.reject(new Error("DB offline")));
    const sseHub = { emit: mock(() => {}) };

    const ctx = {
      storage: {
        threads: {
          get: getThread,
        },
      },
    } as unknown as import("@/core/mesh-context").MeshContext;

    const onTitleUpdated = buildOnTitleUpdated({
      ctx,
      sseHub,
      threadId: "thread-1",
      organizationId: "org-1",
    });

    await onTitleUpdated("Fallback title");

    // Emit was still called despite the storage failure
    expect(sseHub.emit).toHaveBeenCalledTimes(1);
    const [, emittedEvent] = (sseHub.emit as ReturnType<typeof mock>).mock
      .calls[0] as [
      string,
      ReturnType<typeof createDecopilotThreadStatusEvent>,
    ];

    expect(emittedEvent.data.title).toBe("Fallback title");
    // Row fields should be undefined/null (from null row)
    expect(emittedEvent.data.virtual_mcp_id).toBeUndefined();
    expect(emittedEvent.data.created_by).toBeUndefined();
  });

  it("emits the row's actual status (not hardcoded in_progress) when the row is completed", async () => {
    const thread = makeThread({ status: "completed" });
    const getThread = mock(() => Promise.resolve(thread));
    const sseHub = { emit: mock(() => {}) };

    const ctx = {
      storage: {
        threads: {
          get: getThread,
        },
      },
    } as unknown as import("@/core/mesh-context").MeshContext;

    const onTitleUpdated = buildOnTitleUpdated({
      ctx,
      sseHub,
      threadId: "thread-1",
      organizationId: "org-1",
    });

    await onTitleUpdated("Auto-generated title");

    const [, emittedEvent] = (sseHub.emit as ReturnType<typeof mock>).mock
      .calls[0] as [
      string,
      ReturnType<typeof createDecopilotThreadStatusEvent>,
    ];

    expect(emittedEvent.data.status).toBe("completed");
    expect(emittedEvent.data.title).toBe("Auto-generated title");
  });

  it("emits to the correct org id regardless of thread org", async () => {
    const thread = makeThread({ organization_id: "other-org" });
    const getThread = mock(() => Promise.resolve(thread));
    const sseHub = { emit: mock(() => {}) };

    const ctx = {
      storage: {
        threads: {
          get: getThread,
        },
      },
    } as unknown as import("@/core/mesh-context").MeshContext;

    const onTitleUpdated = buildOnTitleUpdated({
      ctx,
      sseHub,
      threadId: "thread-1",
      organizationId: "org-correct",
    });

    await onTitleUpdated("Title");

    const [emittedOrgId] = (sseHub.emit as ReturnType<typeof mock>).mock
      .calls[0] as [string, unknown];
    expect(emittedOrgId).toBe("org-correct");
  });
});
