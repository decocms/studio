// apps/api/src/dispatch-queue/thread-gate-queue.test.ts
import { describe, expect, it } from "bun:test";
import { gateStatusToQueueItem } from "./thread-gate-queue";

/**
 * Realistically-shaped fixture: `WorkflowStatus.input` from the installed SDK
 * (`@dbos-inc/dbos-sdk@4.21.6`) is an already-deserialized array of the
 * workflow function's positional args — NOT a `{ json: [...] }` envelope
 * (see `toWorkflowStatus` / `safeParsePositionalArgs` in
 * dist/src/workflow_management.js + dist/src/serialization.js).
 * `threadGateWorkflowFn(ctx: ThreadGateContext)` takes a single positional
 * arg, so `input` is `[ctx]`.
 */
const threadId = "11bda36e";
const gateCtx = {
  threadId,
  request: { messageId: "msg-7", organizationId: "org1", userId: "u1" },
  source: "user-message" as const,
};
const base = {
  workflowID: `thread-run:${threadId}:msg-7`,
  status: "ENQUEUED",
  createdAt: 1782400000000,
  input: [gateCtx],
};

describe("gateStatusToQueueItem", () => {
  it("maps an ENQUEUED gate to a queued item with messageId from the loaded input", () => {
    const item = gateStatusToQueueItem(base as never, threadId);
    expect(item).toEqual({
      workflowId: `thread-run:${threadId}:msg-7`,
      messageId: "msg-7",
      status: "queued",
      enqueuedAt: 1782400000000,
      source: "user-message",
    });
  });

  it("maps a PENDING gate to status 'running'", () => {
    const item = gateStatusToQueueItem(
      { ...base, status: "PENDING" } as never,
      threadId,
    );
    expect(item?.status).toBe("running");
  });

  it("returns null when the workflowID does not match the thread prefix", () => {
    const item = gateStatusToQueueItem(
      { ...base, workflowID: "thread-run:other:msg-7" } as never,
      threadId,
    );
    expect(item).toBeNull();
  });

  it("prefers the request's messageId over the workflow-id suffix (continuation ids are a SHA1, not the message id)", () => {
    const item = gateStatusToQueueItem(
      {
        ...base,
        workflowID: `thread-run:${threadId}:deadbeefsha1continuation`,
        input: [
          {
            ...gateCtx,
            request: { ...gateCtx.request, messageId: "real-msg-id" },
          },
        ],
      } as never,
      threadId,
    );
    expect(item?.messageId).toBe("real-msg-id");
  });

  it("falls back to the workflow-id suffix when input didn't load", () => {
    const item = gateStatusToQueueItem(
      { ...base, input: undefined } as never,
      threadId,
    );
    expect(item?.messageId).toBe("msg-7");
    expect(item?.source).toBeUndefined();
  });

  it("falls back to the workflow-id suffix when the request carries no messageId", () => {
    const item = gateStatusToQueueItem(
      {
        ...base,
        input: [{ ...gateCtx, request: { organizationId: "org1" } }],
      } as never,
      threadId,
    );
    expect(item?.messageId).toBe("msg-7");
  });

  it("omits `source` when the loaded gate context has none", () => {
    const item = gateStatusToQueueItem(
      { ...base, input: [{ threadId, request: gateCtx.request }] } as never,
      threadId,
    );
    expect(item?.source).toBeUndefined();
    expect(Object.hasOwn(item ?? {}, "source")).toBe(false);
  });

  it("carries `source` through from the loaded gate context (e.g. background-tool)", () => {
    const item = gateStatusToQueueItem(
      { ...base, input: [{ ...gateCtx, source: "background-tool" }] } as never,
      threadId,
    );
    expect(item?.source).toBe("background-tool");
  });
});
