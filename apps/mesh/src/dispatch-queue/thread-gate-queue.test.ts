// apps/mesh/src/dispatch-queue/thread-gate-queue.test.ts
import { describe, expect, it } from "bun:test";
import {
  extractUserMessageText,
  gateStatusToQueueItem,
} from "./thread-gate-queue";

const userMsg = (text: string) => ({
  id: "m1",
  role: "user" as const,
  parts: [{ type: "text" as const, text }],
});

describe("extractUserMessageText", () => {
  it("returns the concatenated text parts of the last user message", () => {
    const messages = [
      { id: "a", role: "assistant", parts: [{ type: "text", text: "hi" }] },
      {
        id: "u",
        role: "user",
        parts: [
          { type: "text", text: "hello " },
          { type: "file", url: "mesh-storage:k", mediaType: "image/png" },
          { type: "text", text: "world" },
        ],
      },
    ] as never;
    expect(extractUserMessageText(messages)).toBe("hello world");
  });

  it("returns empty string when there is no user message", () => {
    const messages = [
      { id: "a", role: "assistant", parts: [{ type: "text", text: "hi" }] },
    ] as never;
    expect(extractUserMessageText(messages)).toBe("");
  });

  it("returns empty string for an empty array", () => {
    expect(extractUserMessageText([] as never)).toBe("");
  });
});

describe("gateStatusToQueueItem", () => {
  const threadId = "11bda36e";
  const base = {
    workflowID: `thread-run:${threadId}:msg-7`,
    status: "ENQUEUED",
    createdAt: 1782400000000,
    input: [
      {
        threadId,
        request: { messages: [userMsg("queued text")] },
        source: "user-message",
      },
    ],
  };

  it("maps an ENQUEUED gate to a queued item with parsed messageId + text", () => {
    const item = gateStatusToQueueItem(base as never, threadId);
    expect(item).toEqual({
      workflowId: `thread-run:${threadId}:msg-7`,
      messageId: "msg-7",
      text: "queued text",
      status: "queued",
      enqueuedAt: 1782400000000,
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

  it("tolerates a missing/unshaped input (empty text)", () => {
    const item = gateStatusToQueueItem(
      { ...base, input: undefined } as never,
      threadId,
    );
    expect(item?.text).toBe("");
    expect(item?.messageId).toBe("msg-7");
  });
});
